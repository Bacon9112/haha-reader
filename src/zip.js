/**
 * 最小 ZIP 读取器：解析中央目录，支持 store(0) 与 deflate(8) 两种压缩方式。
 * 浏览器用 DecompressionStream('deflate-raw')，Node 20+ 同样支持，因此无需第三方库。
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('unzip 需要 ArrayBuffer 或 Uint8Array');
}

function findEocd(view) {
  const size = view.byteLength;
  const start = Math.max(0, size - 65557); // EOCD 最长 22 + 65535 注释
  for (let offset = size - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIG) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === size) return offset;
  }
  throw new Error('不是有效的 ZIP / EPUB 文件');
}

async function inflateRaw(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解压整个 ZIP。
 * @returns {Promise<Map<string, Uint8Array>>} 文件名 → 内容
 */
export async function unzip(input) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的电子书');
  }

  const files = new Map();
  let pointer = cdOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > view.byteLength || view.getUint32(pointer, true) !== CEN_SIG) break;

    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);

    const name = new TextDecoder('utf-8').decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    pointer += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LOC_SIG) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      files.set(name, raw.slice());
    } else if (method === 8) {
      files.set(name, await inflateRaw(raw));
    }
    // 其它压缩方式（bzip2 / lzma）在 EPUB 中几乎不出现，忽略即可
  }

  return files;
}

/** 从解压结果里取 UTF-8 文本，找不到返回 null。 */
export function readText(files, path) {
  const data = files.get(path);
  if (!data) return null;
  let bytes = data;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  return new TextDecoder('utf-8').decode(bytes);
}
