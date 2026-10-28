import { defineModule } from '../types.ts';
import { foldersLight } from './agent.ts';

// Chat folders: folders.* (router.ts, registered in server/router.ts), the folder fields of a conversation, and (in the console) the folder tree in the sidebar. Built in, not optional.
export const folders = defineModule({ ...foldersLight });
