import { bridge, siteWindow } from './common.ts';
import { record } from '../security/validation.ts';
const bus = bridge(['vimeo_request_config'], ['vimeo_on_config']);
const id = location.href.match(/(?<![a-z0-9])(\d{5,})/i)?.[0];
function read() {
  if (id) void bus.poll(() => {
    const config = siteWindow.playerConfig;
    if (!record(config)) return false;
    bus.send('vimeo_on_config', { config });
    return true;
  });
}
bus.listen(read);
read();
