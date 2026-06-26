import type net from "node:net";
import type * as BunFfi from "bun:ffi";

type PeerCredentialResult =
  | { ok: true; uid: number; gid?: number; pid?: number }
  | { ok: false; reason: string };

type PeerSocket = net.Socket & {
  fd?: number;
  _handle?: { fd?: number };
};

type FfiModule = typeof BunFfi;
type FfiLibrary<T extends string> = {
  symbols: Record<T, (...args: unknown[]) => number>;
};

let darwinLibrary: FfiLibrary<"getpeereid"> | undefined;
let linuxLibrary: FfiLibrary<"getsockopt"> | undefined;

export async function verifyPeerUid(socket: net.Socket): Promise<PeerCredentialResult> {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (expectedUid === undefined) {
    return { ok: false, reason: "cannot determine daemon uid" };
  }

  const credentials = await readPeerCredentials(socket);
  if (!credentials.ok) {
    return credentials;
  }

  if (credentials.uid !== expectedUid) {
    return {
      ok: false,
      reason: `peer uid ${credentials.uid} does not match daemon uid ${expectedUid}`
    };
  }

  return credentials;
}

async function readPeerCredentials(socket: net.Socket): Promise<PeerCredentialResult> {
  if (process.platform === "darwin") {
    return await readDarwinPeerCredentials(socket);
  }
  if (process.platform === "linux") {
    return await readLinuxPeerCredentials(socket);
  }
  return { ok: false, reason: `peer uid verification is unsupported on ${process.platform}` };
}

async function readDarwinPeerCredentials(socket: net.Socket): Promise<PeerCredentialResult> {
  const fd = socketFd(socket);
  if (fd === undefined) {
    return { ok: false, reason: "accepted socket fd is unavailable" };
  }

  try {
    const ffi = await loadFfi();
    const library =
      darwinLibrary ??
      ffi.dlopen(`/usr/lib/libSystem.B.${ffi.suffix}`, {
        getpeereid: {
          args: [ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.ptr],
          returns: ffi.FFIType.i32
        }
      });
    darwinLibrary = library as FfiLibrary<"getpeereid">;

    const uid = Buffer.alloc(4);
    const gid = Buffer.alloc(4);
    const result = darwinLibrary.symbols.getpeereid(fd, ffi.ptr(uid), ffi.ptr(gid));
    if (result !== 0) {
      return { ok: false, reason: `getpeereid failed with code ${result}` };
    }
    return { ok: true, uid: uid.readUInt32LE(0), gid: gid.readUInt32LE(0) };
  } catch (error) {
    return {
      ok: false,
      reason: `peer uid verification failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function readLinuxPeerCredentials(socket: net.Socket): Promise<PeerCredentialResult> {
  const fd = socketFd(socket);
  if (fd === undefined) {
    return { ok: false, reason: "accepted socket fd is unavailable" };
  }

  try {
    const ffi = await loadFfi();
    const library =
      linuxLibrary ??
      ffi.dlopen("libc.so.6", {
        getsockopt: {
          args: [
            ffi.FFIType.i32,
            ffi.FFIType.i32,
            ffi.FFIType.i32,
            ffi.FFIType.ptr,
            ffi.FFIType.ptr
          ],
          returns: ffi.FFIType.i32
        }
      });
    linuxLibrary = library as FfiLibrary<"getsockopt">;

    const credentials = Buffer.alloc(12);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(credentials.length, 0);
    const result = linuxLibrary.symbols.getsockopt(
      fd,
      1,
      17,
      ffi.ptr(credentials),
      ffi.ptr(length)
    );
    if (result !== 0) {
      return { ok: false, reason: `getsockopt(SO_PEERCRED) failed with code ${result}` };
    }
    return {
      ok: true,
      pid: credentials.readInt32LE(0),
      uid: credentials.readUInt32LE(4),
      gid: credentials.readUInt32LE(8)
    };
  } catch (error) {
    return {
      ok: false,
      reason: `peer uid verification failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function loadFfi(): Promise<FfiModule> {
  return await import("bun:ffi");
}

function socketFd(socket: net.Socket): number | undefined {
  const peerSocket = socket as PeerSocket;
  return peerSocket.fd ?? peerSocket._handle?.fd;
}
