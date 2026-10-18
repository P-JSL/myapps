import { bridge, siteWindow } from './common.ts';
import { record } from '../security/validation.ts';
const bus = bridge(['bilibili_com_request_id', 'bilibili_tv_request_config'], ['bilibili_tv_on_config', 'bilibili_com_on_id']);
function read(name: string) {
  void bus.poll(() => {
    if (name === 'bilibili_com_request_id') {
      const state = siteWindow.__INITIAL_STATE__;
      if (!record(state) || !state.cid || !record(state.videoData) || !state.videoData.bvid) return false;
      bus.send('bilibili_com_on_id', { cid: state.cid, bvid: state.videoData.bvid });
    } else {
      const state = siteWindow.__initialState;
      if (!record(state) || !record(state.ogv) || !record(state.ugc)) return false;
      const epId = record(state.ogv.epId) ? state.ogv.epId._value : undefined;
      const aiId = record(state.ugc.aid) ? state.ugc.aid._value : undefined;
      if (!epId && !aiId) return false;
      bus.send('bilibili_tv_on_config', { ep_id: epId, ai_id: aiId });
    }
    return true;
  });
}
bus.listen(read);
if (/\.com\/video\//.test(location.href)) read('bilibili_com_request_id');
if (/\.tv\/.+\/(?:play|video)\//.test(location.href)) read('bilibili_tv_request_config');
