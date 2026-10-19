/** Audit regressions use real MP4 fragments and the source planner in Chromium. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr?.slice(-2000)}`);
}

export async function prepareDashAuditFixtures(fixtures) {
  const offset = path.join(fixtures, 'audit-offset');
  await mkdir(offset, { recursive: true });
  await mkdir(path.join(fixtures, 'audit-list'), { recursive: true });
  // These fragments really start near 100s; the MPD offset places their
  // presentation at 0s. Merely relabeling zero-based fragment URLs would miss it.
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(fixtures, 'clip.mp4'), '-map', '0', '-c', 'copy', '-output_ts_offset', '100', '-seg_duration', '0.5', '-use_template', '1', '-use_timeline', '1', '-f', 'dash', '-y', path.join(offset, 'list.mpd')]);
  command('python3', ['-c', `import pathlib,re,xml.etree.ElementTree as E
p=pathlib.Path(${JSON.stringify(fixtures)});ns='{urn:mpeg:dash:schema:mpd:2011}'
tree=E.parse(p/'audit-offset/list.mpd');root=tree.getroot()
for adaptation in root.iter(ns+'AdaptationSet'):
 rep=adaptation.find(ns+'Representation');template=rep.find(ns+'SegmentTemplate')
 scale=int(template.attrib.get('timescale','1'))
 template.set('presentationTimeOffset',str(100*scale))
 if rep.attrib.get('mimeType','').startswith('video/'):
  timeline=template.find(ns+'SegmentTimeline');entries=timeline.findall(ns+'S')
  assert len(entries)==1,'This fixture requires its single-keyframe video segment'
  start=int(entries[0].attrib['t']);entries[0].set('r','-1')
  old=template.attrib['media'].replace('$RepresentationID$',rep.attrib['id']).replace('$Number%05d$','00001')
  new='chunk-stream'+rep.attrib['id']+'-'+str(start)+'.m4s'
  (p/'audit-offset'/old).replace(p/'audit-offset'/new)
  template.set('media','chunk-stream$RepresentationID$-$Time$.m4s')
 init=template.attrib.pop('initialization');rep.remove(template);adaptation.insert(0,template)
 E.SubElement(rep,ns+'SegmentTemplate',initialization=init)
tree.write(p/'audit-offset/list.mpd',encoding='unicode')

tree=E.parse(p/'dash/list.mpd');root=tree.getroot()
for adaptation in root.iter(ns+'AdaptationSet'):
 rep=adaptation.find(ns+'Representation');template=rep.find(ns+'SegmentTemplate')
 ident=rep.attrib['id'];number=int(template.attrib.get('startNumber','1'));time=0;urls=[]
 def expand(value,time,number):
  def replace(m):
   key=m.group(1);width=int(m.group(2) or '0')
   value={'RepresentationID':ident,'Bandwidth':rep.attrib.get('bandwidth',''),'Time':str(time),'Number':str(number)}[key]
   return value.zfill(width)
  return re.sub(r'\\$(RepresentationID|Bandwidth|Time|Number)(?:%0(\\d+)d)?\\$',replace,value)
 for entry in template.find(ns+'SegmentTimeline').findall(ns+'S'):
  time=int(entry.attrib.get('t',time));d=int(entry.attrib['d']);repeat=int(entry.attrib.get('r','0'))
  assert repeat>=0,'Baseline fixture has finite explicit repetitions'
  for i in range(repeat+1):
   urls.append(expand(template.attrib['media'],time,number));time+=d;number+=1
 init=expand(template.attrib['initialization'],0,0)
 rep.remove(template)
 parent=E.SubElement(adaptation,ns+'SegmentList')
 E.SubElement(parent,ns+'Initialization',sourceURL=init)
 E.SubElement(parent,ns+'SegmentURL',media='must-not-request-parent-fragment.m4s')
 replacement=E.SubElement(rep,ns+'SegmentList')
 for url in urls:E.SubElement(replacement,ns+'SegmentURL',media=url)
 E.SubElement(rep,ns+'BaseURL').text='../dash/'
tree.write(p/'audit-list/list.mpd',encoding='unicode')
`]);
  // Browser-only test module: Node has no DOMParser. It is served from fixtures
  // and is never included in the installed extension.
  await build({ entryPoints: ['src/local/dash.ts'], bundle: true, format: 'esm', outfile: path.join(fixtures, 'dash-planner-audit.js') });
}

export async function verifyDashPlanner(page, origin) {
  const outcomes = await page.evaluate(async origin => {
    const { planDash } = await import(`${origin}/fixtures/dash-planner-audit.js`);
    const wrap = (inside, duration = 'PT2S') => `<MPD type="static" mediaPresentationDuration="${duration}"><Period><AdaptationSet mimeType="video/mp4">${inside}</AdaptationSet></Period></MPD>`;
    const rep = inside => `<Representation id="v" bandwidth="1">${inside}</Representation>`;
    const cases = {
      inheritedOffset: wrap('<SegmentTemplate timescale="1" presentationTimeOffset="100" initialization="init.mp4" media="seg-$Time$.m4s"><SegmentTimeline><S t="100" d="1" r="-1"/></SegmentTimeline></SegmentTemplate>' + rep('<SegmentTemplate/>')),
      overriddenOffset: wrap('<SegmentTemplate timescale="1" presentationTimeOffset="200" initialization="init.mp4" media="seg-$Time$.m4s"><SegmentTimeline><S t="100" d="1" r="-1"/></SegmentTimeline></SegmentTemplate>' + rep('<SegmentTemplate presentationTimeOffset="100"/>')),
      fractionalEnd: wrap(rep('<SegmentTemplate timescale="10" presentationTimeOffset="100" media="seg-$Time$.m4s"><SegmentTimeline><S t="100" d="1" r="-1"/></SegmentTimeline></SegmentTemplate>'), 'PT0.333S'),
      explicitNext: wrap(rep('<SegmentTemplate timescale="1" presentationTimeOffset="100" media="seg-$Time$.m4s"><SegmentTimeline><S t="100" d="1" r="-1"/><S t="102" d="1"/></SegmentTimeline></SegmentTemplate>'), 'PT3S'),
      zeroOffset: wrap(rep('<SegmentTemplate timescale="1" media="seg-$Time$.m4s"><SegmentTimeline><S t="0" d="1" r="-1"/></SegmentTimeline></SegmentTemplate>')),
      lists: wrap('<SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="obsolete.m4s"/></SegmentList>' + rep('<SegmentList><SegmentURL media="one.m4s"/><SegmentURL media="two.m4s"/></SegmentList>')),
      listOverride: wrap('<SegmentList><Initialization sourceURL="wrong.mp4"/><SegmentURL media="one.m4s"/><SegmentURL media="two.m4s"/></SegmentList>' + rep('<SegmentList><Initialization sourceURL="init.mp4"/></SegmentList>')),
      overflow: wrap(rep('<SegmentTemplate timescale="1" presentationTimeOffset="9007199254740991" media="seg-$Time$.m4s"><SegmentTimeline><S t="9007199254740991" d="1" r="-1"/></SegmentTimeline></SegmentTemplate>')),
      arithmeticOverflow: wrap(rep('<SegmentTemplate timescale="1" media="seg-$Time$.m4s"><SegmentTimeline><S t="9007199254740990" d="2"/></SegmentTimeline></SegmentTemplate>')),
      missingNextStart: wrap(rep('<SegmentTemplate timescale="1" media="seg-$Time$.m4s"><SegmentTimeline><S t="0" d="1" r="-1"/><S d="1"/></SegmentTimeline></SegmentTemplate>')),
    };
    const result = {};
    for (const [key, xml] of Object.entries(cases)) {
      try { result[key] = { files: planDash(xml, 'https://media.test/list.mpd').assets.map(asset => new URL(asset.url).pathname.split('/').at(-1)) }; }
      catch (error) { result[key] = { error: error.message }; }
    }
    return result;
  }, origin);
  assert.deepEqual(outcomes.inheritedOffset.files, ['init.mp4', 'seg-100.m4s', 'seg-101.m4s']);
  assert.deepEqual(outcomes.overriddenOffset.files, ['init.mp4', 'seg-100.m4s', 'seg-101.m4s']);
  assert.deepEqual(outcomes.fractionalEnd.files, ['seg-100.m4s', 'seg-101.m4s', 'seg-102.m4s', 'seg-103.m4s']);
  assert.deepEqual(outcomes.explicitNext.files, ['seg-100.m4s', 'seg-101.m4s', 'seg-102.m4s']);
  assert.deepEqual(outcomes.zeroOffset.files, ['seg-0.m4s', 'seg-1.m4s']);
  for (const key of ['lists', 'listOverride']) assert.deepEqual(outcomes[key].files, ['init.mp4', 'one.m4s', 'two.m4s']);
  for (const key of ['overflow', 'arithmeticOverflow', 'missingNextStart']) assert.equal(typeof outcomes[key].error, 'string', `${key} must reject unsafe or unbounded expansion`);
}
