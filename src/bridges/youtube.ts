import { bridge, siteWindow } from './common.ts';
import { record } from '../security/validation.ts';
const bus = bridge(['youtube_request_visitor_data'], ['youtube_on_visitor_data']);
function read() {
  const config = siteWindow.ytcfg;
  const data = record(config) ? config.data_ : undefined;
  bus.send('youtube_on_visitor_data', { visitor_data: record(data) ? data.VISITOR_DATA : undefined });
}
bus.listen(read);
read();
