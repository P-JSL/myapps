import { MAX_SEGMENTS, mediaURL } from './model.ts';
import { validRange, type ByteRange } from './network.ts';
import type { RemoteAsset, StreamPlan } from './hls.ts';
import { chooseQuality, downloadOptions, type DownloadOptions } from './preferences.ts';

function child(node: Element, name: string): Element | undefined { return Array.from(node.children).find(e => e.localName === name); }
function children(node: Element, name: string): Element[] { return Array.from(node.children).filter(e => e.localName === name); }
function duration(text: string | null): number {
  const m = text?.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : 0;
}
function range(text: string | null): ByteRange | undefined {
  if (!text) return undefined;
  const match = text.match(/^(\d+)-(\d+)$/);
  if (!match) throw new Error('DASH 바이트 범위가 올바르지 않습니다.');
  const result = { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 }; validRange(result); return result;
}
export function planDash(text: string, address: string, options: DownloadOptions = downloadOptions()): StreamPlan {
  if (text.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('지원하지 않는 DASH 문서입니다.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (root.localName !== 'MPD' || doc.getElementsByTagName('parsererror').length) throw new Error('올바른 DASH 목록이 아닙니다.');
  if (root.getAttribute('type') === 'dynamic') throw new Error('현재 로컬 버전은 완료된 VOD 목록만 지원합니다.');
  if (doc.getElementsByTagNameNS('*', 'ContentProtection').length) throw new Error('암호화·DRM 스트림은 지원하지 않습니다.');
  const periods = children(root, 'Period');
  if (periods.length !== 1) throw new Error('현재는 단일 Period DASH 목록만 지원합니다.');
  const period = periods[0]!;
  const seconds = duration(period.getAttribute('duration')) || duration(root.getAttribute('mediaPresentationDuration'));
  const selections: Array<{ adaptation: Element; representation: Element; type: string }> = [];
  for (const adaptation of children(period, 'AdaptationSet')) {
    for (const representation of children(adaptation, 'Representation')) {
      const type = representation.getAttribute('mimeType') ?? adaptation.getAttribute('mimeType') ?? adaptation.getAttribute('contentType') ?? '';
      if (/^(video|audio)/.test(type)) selections.push({ adaptation, representation, type: type.startsWith('video') ? 'video' : 'audio' });
    }
  }
  const audio = chooseQuality(selections.filter(s => s.type === 'audio'), 'highest', () => 0,
    item => Number(item.representation.getAttribute('bandwidth')));
  const video = chooseQuality(selections.filter(s => s.type === 'video'), options.quality,
    item => Number(item.representation.getAttribute('height') ?? item.adaptation.getAttribute('height')),
    item => Number(item.representation.getAttribute('bandwidth')));
  const picked = (options.output !== 'original' && audio ? [audio] : [video, audio]).filter(s => s !== undefined);
  if (!picked.length) throw new Error('DASH 미디어 트랙이 없습니다.');
  const plan: StreamPlan = { assets: [], inputs: [] };
  for (const item of picked) {
    const chain = [root, period, item.adaptation, item.representation];
    let base = mediaURL(address).href;
    for (const node of chain) { const value = child(node, 'BaseURL')?.textContent?.trim(); if (value) base = mediaURL(value, base).href; }
    const parts: string[] = [];
    function add(url: string, bytes?: ByteRange) {
      if (plan.assets.length >= MAX_SEGMENTS) throw new Error('미디어 조각 개수 한도를 초과했습니다.');
      const asset: RemoteAsset = { url: mediaURL(url, base).href, filename: `dash-${plan.assets.length}.m4s` };
      if (bytes) asset.range = bytes;
      plan.assets.push(asset); parts.push(asset.filename);
    }
    const lists = [...chain].reverse().map(node => child(node, 'SegmentList')).filter(node => node !== undefined);
    const list = lists[0];
    const templates = [...chain].reverse().map(node => child(node, 'SegmentTemplate')).filter(node => node !== undefined);
    const template = templates[0];
    // A descendant SegmentTemplate overrides individual attributes and complete
    // SegmentTimeline children, while omitted values inherit from its ancestors.
    const templateAttribute = (name: string) => templates.find(node => node.hasAttribute(name))?.getAttribute(name) ?? null;
    if (list) {
      // Initialization and the complete URL list inherit independently. A child
      // list can replace its segments without repeating the parent's init data.
      const init = lists.map(node => child(node, 'Initialization')).find(node => node !== undefined);
      if (init) add(init.getAttribute('sourceURL') ?? base, range(init.getAttribute('range')));
      const segments = lists.map(node => children(node, 'SegmentURL')).find(nodes => nodes.length) ?? [];
      for (const segment of segments) add(segment.getAttribute('media') ?? base, range(segment.getAttribute('mediaRange')));
    } else if (template) {
      const timescale = Number(templateAttribute('timescale') ?? '1');
      const presentationTimeOffset = Number(templateAttribute('presentationTimeOffset') ?? '0');
      let number = Number(templateAttribute('startNumber') ?? '1');
      if (!Number.isSafeInteger(timescale) || timescale <= 0 || !Number.isSafeInteger(presentationTimeOffset) || presentationTimeOffset < 0
        || !Number.isSafeInteger(number) || number < 0) throw new Error('DASH 타임라인이 올바르지 않습니다.');
      const expand = (format: string, time: number) => format.replace(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (match, key: string, width: string | undefined) => {
        if (match === '$$') return '$';
        const value = key === 'RepresentationID' ? item.representation.getAttribute('id') ?? '' : key === 'Bandwidth' ? item.representation.getAttribute('bandwidth') ?? '' : String(key === 'Time' ? time : number);
        const pad = Number(width ?? 0); if (pad > 20) throw new Error('DASH 번호 형식이 너무 깁니다.');
        return value.padStart(pad, '0');
      });
      const init = templateAttribute('initialization');
      if (init) add(expand(init, 0));
      const format = templateAttribute('media');
      if (!format) throw new Error('DASH 미디어 템플릿이 없습니다.');
      const timeline = templates.map(node => child(node, 'SegmentTimeline')).find(node => node !== undefined);
      if (timeline) {
        const entries = children(timeline, 'S');
        let time = 0;
        for (let index = 0; index < entries.length; index++) {
          const s = entries[index]!;
          if (s.hasAttribute('t')) time = Number(s.getAttribute('t'));
          const d = Number(s.getAttribute('d'));
          let repeat = Number(s.getAttribute('r') ?? '0');
          if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(d) || d <= 0 || !Number.isSafeInteger(repeat) || repeat < -1) throw new Error('DASH 타임라인이 올바르지 않습니다.');
          if (repeat === -1) {
            const next = entries[index + 1];
            const end = next ? Number(next.getAttribute('t')) : seconds * timescale + presentationTimeOffset;
            // Segment timestamps use the media timeline; the Period duration is
            // on the presentation timeline and must include its inherited offset.
            // A fractional Period boundary is valid even with an integer timescale.
            if ((next && (!next.hasAttribute('t') || !Number.isSafeInteger(end))) || (!next && seconds <= 0)
              || !Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER || end <= time) throw new Error('끝이 없는 DASH 타임라인은 지원하지 않습니다.');
            repeat = Math.ceil((end - time) / d) - 1;
          }
          if (repeat >= MAX_SEGMENTS) throw new Error('DASH 조각 개수 한도를 초과했습니다.');
          if (!Number.isSafeInteger(time + (repeat + 1) * d) || !Number.isSafeInteger(number + repeat)) throw new Error('DASH 타임라인이 올바르지 않습니다.');
          for (let i = 0; i <= repeat; i++) { add(expand(format, time)); time += d; number++; }
        }
      } else {
        const step = Number(templateAttribute('duration'));
        const count = Math.ceil(seconds * timescale / step);
        if (!Number.isFinite(count) || count < 1 || count > MAX_SEGMENTS) throw new Error('DASH 길이 또는 조각 개수가 허용 범위를 초과했습니다.');
        for (let i = 0; i < count; i++) { add(expand(format, i * step)); number++; }
      }
    } else {
      if (base === mediaURL(address).href) throw new Error('DASH 조각 정보를 찾을 수 없습니다.');
      add(base);
    }
    if (!parts.length) throw new Error('DASH 트랙이 비어 있습니다.');
    plan.inputs.push({ filename: `input-${plan.inputs.length}.mp4`, parts });
  }
  return plan;
}
