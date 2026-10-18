import { bridge, siteWindow } from './common.ts';
import { record } from '../security/validation.ts';
const bus = bridge(['iq_request_config'], ['iq_on_config']);
function read() {
  void bus.poll(() => {
    const config = siteWindow.__playerdata__;
    if (!record(config)) return false;
    bus.send('iq_on_config', { config });
    return true;
  });
}
bus.listen(read);
read();
