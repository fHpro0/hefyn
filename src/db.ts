import { sqlite } from '@flue/runtime/node';

export default sqlite(`${process.env.HEFYN_DATA_DIR ?? './data'}/flue.db`);
