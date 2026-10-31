import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const privateDirectory = process.env.MUZE_PRIVATE_DIR || join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/Muze' : '.local/share/muze');
export const digest = value => createHash('sha256').update(value).digest('hex');
