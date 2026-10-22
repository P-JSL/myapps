/** Offline, bounded risk signals only. A completed scan is never a malware-clear verdict. */
export interface InternalFinding {
  id: string; severity: 'high' | 'warning'; message: string; offset?: number;
}
export interface InternalScanResult {
  version: 1; engine: 'builtin-static-v1'; status: 'no-signals' | 'suspicious' | 'incomplete';
  scannedBytes: number; complete: boolean; findings: InternalFinding[];
}
export interface InternalScanOptions { complete?: boolean; expectedMedia?: boolean; }

const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_FINDINGS = 16;
const MAX_STRUCTURES = 512;
// Numeric bytes keep the harmless standard AV test marker out of packaged source text.
const TEST_MARKER = new Uint8Array([88,53,79,33,80,37,64,65,80,91,52,92,80,90,88,53,52,40,80,94,41,55,67,67,41,55,125,36,69,73,67,65,82,45,83,84,65,78,68,65,82,68,45,65,78,84,73,86,73,82,85,83,45,84,69,83,84,45,70,73,76,69,33,36,72,43,72,42]);
const MARKER_FAILURE = new Uint8Array(TEST_MARKER.length);
for (let i = 1, matched = 0; i < TEST_MARKER.length; i++) {
  while (matched && TEST_MARKER[i] !== TEST_MARKER[matched]) matched = MARKER_FAILURE[matched - 1]!;
  if (TEST_MARKER[i] === TEST_MARKER[matched]) matched++;
  MARKER_FAILURE[i] = matched;
}
function at(bytes: Uint8Array, offset: number, values: readonly number[]): boolean {
  return offset >= 0 && offset + values.length <= bytes.length && values.every((value, index) => bytes[offset + index] === value);
}
function word(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let i = 0; i < value.length; i++) if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  return true;
}
function u16(bytes: Uint8Array, offset: number, little = true): number {
  return little ? bytes[offset]! + bytes[offset + 1]! * 256 : bytes[offset]! * 256 + bytes[offset + 1]!;
}
function u32(bytes: Uint8Array, offset: number, little = true): number {
  return little ? bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536 + bytes[offset + 3]! * 16777216
    : bytes[offset]! * 16777216 + bytes[offset + 1]! * 65536 + bytes[offset + 2]! * 256 + bytes[offset + 3]!;
}
interface PEHeader { offset: number; table: number; sections: number; headers: number; }
function peHeader(bytes: Uint8Array, offset: number): PEHeader | undefined {
  if (!at(bytes, offset, [77, 90]) || offset + 64 > bytes.length) return undefined;
  const relative = u32(bytes, offset + 60);
  if (relative < 64 || relative > 1024 * 1024) return undefined;
  const pe = offset + relative;
  if (pe + 24 > bytes.length || !at(bytes, pe, [80, 69, 0, 0])) return undefined;
  const machine = u16(bytes, pe + 4), sections = u16(bytes, pe + 6), optionalBytes = u16(bytes, pe + 20);
  if (![0x14c, 0x8664, 0xaa64, 0x1c0, 0x1c4].includes(machine) || !sections || sections > 96 || !(u16(bytes, pe + 22) & 2)) return undefined;
  const optional = pe + 24;
  if (optionalBytes < 96 || optional + optionalBytes > bytes.length) return undefined;
  const magic = u16(bytes, optional);
  if (magic !== 0x10b && magic !== 0x20b || magic === 0x20b && optionalBytes < 112) return undefined;
  const table = optional + optionalBytes, headers = u32(bytes, optional + 60), image = u32(bytes, optional + 56);
  if (headers < table + sections * 40 - offset || headers > bytes.length - offset || image < headers) return undefined;
  return { offset, table, sections, headers };
}
function peSections(bytes: Uint8Array, header: PEHeader): boolean {
  let populated = false;
  for (let i = 0; i < header.sections; i++) {
    const section = header.table + i * 40, size = u32(bytes, section + 16), relative = u32(bytes, section + 20);
    if (size && (relative < header.headers || relative > bytes.length - header.offset || size > bytes.length - header.offset - relative)) return false;
    populated ||= size > 0;
  }
  return populated;
}
function elf(bytes: Uint8Array): boolean {
  if (!at(bytes, 0, [127, 69, 76, 70]) || ![1, 2].includes(bytes[4] ?? 0) || ![1, 2].includes(bytes[5] ?? 0) || bytes[6] !== 1) return false;
  const headerBytes = bytes[4] === 2 ? 64 : 52;
  if (bytes.length < headerBytes) return false;
  const little = bytes[5] === 1;
  return [2, 3].includes(u16(bytes, 16, little)) && [3, 40, 62, 183, 243].includes(u16(bytes, 18, little))
    && u32(bytes, 20, little) === 1 && u16(bytes, bytes[4] === 2 ? 52 : 40, little) === headerBytes;
}
function machO(bytes: Uint8Array, offset = 0, length = bytes.length): boolean {
  if (length < 28 || offset + length > bytes.length) return false;
  const magic = u32(bytes, offset, false), little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) return false;
  const header = magic === 0xfeedfacf || magic === 0xcffaedfe ? 32 : 28;
  if (length < header) return false;
  const cpu = u32(bytes, offset + 4, little), type = u32(bytes, offset + 12, little);
  const commands = u32(bytes, offset + 16, little), commandBytes = u32(bytes, offset + 20, little);
  return [7, 12, 0x1000007, 0x100000c].includes(cpu) && [2, 6, 8].includes(type)
    && commands > 0 && commands <= 1024 && commandBytes >= commands * 8 && commandBytes <= length - header;
}
function executableMachO(bytes: Uint8Array): boolean {
  if (machO(bytes)) return true;
  if (bytes.length < 8) return false;
  const magic = u32(bytes, 0, false), little = magic === 0xbebafeca || magic === 0xbfbafeca;
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return false;
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca, count = u32(bytes, 4, little), stride = wide ? 32 : 20;
  const tableEnd = 8 + count * stride;
  if (!count || count > 16 || tableEnd > bytes.length) return false;
  for (let i = 0; i < count; i++) {
    const entry = 8 + i * stride, offsetField = entry + 8, sizeField = entry + (wide ? 16 : 12);
    // The scan window is <2^32; larger universal slices cannot be fully inspected.
    if (wide && (u32(bytes, offsetField + (little ? 4 : 0), little) || u32(bytes, sizeField + (little ? 4 : 0), little))) return false;
    const offset = u32(bytes, offsetField + (wide && !little ? 4 : 0), little), length = u32(bytes, sizeField + (wide && !little ? 4 : 0), little);
    if (offset < tableEnd || !machO(bytes, offset, length)) return false;
  }
  return true;
}
function archiveHead(bytes: Uint8Array): boolean {
  return at(bytes, 0, [80, 75, 3, 4]) || at(bytes, 0, [80, 75, 5, 6]) || at(bytes, 0, [80, 75, 7, 8])
    || at(bytes, 0, [82, 97, 114, 33, 26, 7]) || at(bytes, 0, [55, 122, 188, 175, 39, 28]) || at(bytes, 0, [31, 139, 8]);
}
function textHead(bytes: Uint8Array): 'pdf' | 'script' | undefined {
  const utf16le = at(bytes, 0, [255, 254]), utf16be = at(bytes, 0, [254, 255]);
  let offset = utf16le || utf16be ? 2 : at(bytes, 0, [239, 187, 191]) ? 3 : 0, prefix = '';
  const width = utf16le || utf16be ? 2 : 1;
  for (let count = 0; count < 256 && offset + width <= bytes.length; count++, offset += width) {
    const value = width === 2 ? u16(bytes, offset, utf16le) : bytes[offset]!;
    if (value > 127 || value < 9 || value > 13 && value < 32) break;
    prefix += String.fromCharCode(value);
  }
  prefix = prefix.replace(/^[\t\n\r ]+/, '');
  if (prefix.startsWith('%PDF-')) return 'pdf';
  return /^(?:<!doctype\s+html\b|<html\b|<script\b|<svg\b|<iframe\b|<\?php\b|#!|@echo\s+off\b|#requires\b)/i.test(prefix) ? 'script' : undefined;
}
/** Header recognition is only scope selection; the app's format parser still validates media. */
function mediaHead(bytes: Uint8Array): boolean {
  if (at(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) || at(bytes, 0, [255, 216, 255]) || at(bytes, 0, [26, 69, 223, 163])) return true;
  if (bytes.length >= 12 && word(bytes, 0, 'RIFF') && ['WAVE', 'AVI ', 'WEBP'].some(type => word(bytes, 8, type))) return true;
  if (bytes.length >= 12 && ['ftyp', 'moov', 'moof', 'styp', 'free', 'skip', 'wide'].some(type => word(bytes, 4, type))) return true;
  if (bytes.length >= 8 && (word(bytes, 0, 'OggS') || word(bytes, 0, 'fLaC'))) return true;
  if (bytes.length >= 10 && word(bytes, 0, 'ID3') && [2, 3, 4].includes(bytes[3]!)) return true;
  if (bytes.length >= 4 && bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0 && ((bytes[1]! >> 3) & 3) !== 1
    && ((bytes[1]! >> 1) & 3) === 1 && bytes[2]! >> 4 > 0 && bytes[2]! >> 4 < 15 && ((bytes[2]! >> 2) & 3) < 3) return true;
  if (bytes.length >= 7 && bytes[0] === 255 && (bytes[1]! & 0xf6) === 0xf0 && ((bytes[2]! >> 2) & 15) < 13) return true;
  return bytes.length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
}
/** Accept only a closed, bounded ZIP directory with corresponding local records. */
function appendedZip(bytes: Uint8Array): { offset?: number; limited: boolean } {
  let candidates = 0, directoryBytes = 0;
  const minimum = Math.max(0, bytes.length - 22 - 65535);
  for (let end = bytes.length - 22; end >= minimum; end--) {
    if (!at(bytes, end, [80, 75, 5, 6]) || end + 22 + u16(bytes, end + 20) !== bytes.length) continue;
    if (++candidates > 16) return { limited: true };
    // An EOF-shaped ZIP record outside our supported scope cannot establish
    // complete inspection. This includes split archives and ZIP64 sentinels.
    if (u16(bytes, end + 4) || u16(bytes, end + 6)) return { limited: true };
    const entries = u16(bytes, end + 10), size = u32(bytes, end + 12), relative = u32(bytes, end + 16);
    if (entries > 1024 || u16(bytes, end + 8) === 65535 || size === 0xffffffff || relative === 0xffffffff || size > 1024 * 1024) return { limited: true };
    if (!entries || entries !== u16(bytes, end + 8) || size < entries * 46 || size > end) continue;
    const start = end - size, base = start - relative;
    if (base < 0) continue;
    let cursor = start, firstLocal = bytes.length, valid = true;
    for (let i = 0; i < entries; i++) {
      if (cursor + 46 > end || !at(bytes, cursor, [80, 75, 1, 2])) { valid = false; break; }
      const name = u16(bytes, cursor + 28), extra = u16(bytes, cursor + 30), comment = u16(bytes, cursor + 32);
      directoryBytes += 46 + name;
      if (directoryBytes > 1024 * 1024) return { limited: true };
      const next = cursor + 46 + name + extra + comment, local = base + u32(bytes, cursor + 42), compressed = u32(bytes, cursor + 20);
      if (!name || next > end || u16(bytes, cursor + 34) || local < 0 || local + 30 > start || !at(bytes, local, [80, 75, 3, 4])
        || u16(bytes, local + 8) !== u16(bytes, cursor + 10) || u16(bytes, local + 26) !== name) { valid = false; break; }
      const data = local + 30 + name + u16(bytes, local + 28);
      if (data > start || compressed > start - data) { valid = false; break; }
      for (let j = 0; j < name; j++) if (bytes[local + 30 + j] !== bytes[cursor + 46 + j]) { valid = false; break; }
      if (!valid) break;
      firstLocal = Math.min(firstLocal, local); cursor = next;
    }
    if (valid && cursor === end && firstLocal > 0) return { offset: firstLocal, limited: false };
  }
  return { limited: false };
}

/**
 * Full bytes are inspected, up to 256 MiB. Set complete:false for a prefix.
 * expectedMedia:false is explicit raw-fragment mode: it omits standalone format
 * classification, but still checks all limited signatures/structures. No-signals
 * means only that these rules found no signals, never that the file is safe.
 */
export function scanBytes(input: Uint8Array, options: InternalScanOptions = {}): InternalScanResult {
  if (!(input instanceof Uint8Array)) throw new TypeError('검사 입력은 바이트 배열이어야 합니다.');
  const bytes = input.subarray(0, MAX_SCAN_BYTES), findings: InternalFinding[] = [];
  let complete = options.complete !== false && input.length <= MAX_SCAN_BYTES && bytes.length > 0;
  let suspicious = false, structures = 0, structureLimit = false;
  const add = (finding: InternalFinding, risk = true) => {
    suspicious ||= risk;
    if (findings.length < MAX_FINDINGS) findings.push(finding);
  };
  const expectedMedia = options.expectedMedia !== false, recognized = mediaHead(bytes);
  if (elf(bytes)) add({ id: 'executable-elf', severity: 'high', message: '미디어 대신 ELF 실행 파일 구조가 발견되었습니다.', offset: 0 });
  if (executableMachO(bytes)) add({ id: 'executable-mach-o', severity: 'high', message: '미디어 대신 Mach-O 실행 파일 구조가 발견되었습니다.', offset: 0 });
  if (expectedMedia && archiveHead(bytes)) add({ id: 'non-media-archive', severity: 'warning', message: '미디어 대신 압축 파일의 시작 구조가 발견되었습니다.', offset: 0 });
  if (expectedMedia) {
    const type = textHead(bytes);
    if (type) add({ id: `non-media-${type}`, severity: 'warning', message: type === 'pdf' ? '미디어 대신 PDF 문서의 시작 구조가 발견되었습니다.' : '미디어 대신 스크립트·활성 문서의 시작 구조가 발견되었습니다.', offset: 0 });
  }
  let marker = 0;
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!;
    while (marker && value !== TEST_MARKER[marker]) marker = MARKER_FAILURE[marker - 1]!;
    if (value === TEST_MARKER[marker]) marker++;
    if (marker === TEST_MARKER.length) {
      add({ id: 'eicar-test-marker', severity: 'high', message: '무해한 표준 백신 시험 문자열(EICAR)이 발견되었습니다. 실제 악성코드 판정은 아닙니다.', offset: i + 1 - TEST_MARKER.length });
      marker = MARKER_FAILURE[marker - 1]!;
    }
    if (value === 77 && bytes[i + 1] === 90) {
      const header = peHeader(bytes, i);
      if (!header) continue;
      if (++structures > MAX_STRUCTURES) { structureLimit = true; continue; }
      if (peSections(bytes, header)) add({ id: i === 0 ? 'executable-pe' : 'embedded-pe', severity: 'high',
        message: i === 0 ? '미디어 대신 Windows PE 실행 파일 구조가 발견되었습니다.' : '파일 내부에서 유효한 Windows PE 실행 파일 구조가 발견되었습니다. 첨부·위장 여부를 확인하세요.', offset: i });
    }
  }
  if (recognized && complete) {
    const zip = appendedZip(bytes);
    structureLimit ||= zip.limited;
    if (zip.offset !== undefined) add({ id: 'appended-zip', severity: 'warning', message: '미디어 안에 별도의 ZIP 파일 구조가 발견되었습니다. 위장·첨부 여부를 확인하세요.', offset: zip.offset });
  }
  if (structureLimit) complete = false;
  if (expectedMedia && !recognized) complete = false;
  if (!complete) {
    const id = input.length > MAX_SCAN_BYTES || structureLimit ? 'analysis-limit' : !bytes.length ? 'empty-input' : options.complete === false ? 'partial-input' : 'unsupported-format';
    const message = id === 'analysis-limit' ? '내부 검사 한도를 초과해 일부 내용을 확인하지 못했습니다.' : id === 'empty-input' ? '검사할 파일 내용이 없습니다.'
      : id === 'partial-input' ? '제공된 일부 바이트만 검사했으며 전체 파일 검사는 완료하지 않았습니다.' : '지원하는 미디어 시작 구조를 확인하지 못해 내부 검사를 완료하지 않았습니다.';
    add({ id, severity: 'warning', message }, false);
  }
  return { version: 1, engine: 'builtin-static-v1', status: suspicious ? 'suspicious' : complete ? 'no-signals' : 'incomplete', scannedBytes: bytes.length, complete, findings };
}
