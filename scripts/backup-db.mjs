import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source=path.resolve(root,process.env.DATABASE_PATH||'data/mirari.sqlite');
const target=process.argv[2]?path.resolve(process.argv[2]):null;
if(!target)throw new Error('Usage: npm run backup -- <new-backup-path.sqlite>');
if(!existsSync(source))throw new Error('Source database does not exist.');
if(existsSync(target))throw new Error('Backup target already exists; choose a new path.');
if(source===target)throw new Error('Backup target must differ from the source.');
mkdirSync(path.dirname(target),{recursive:true});
const db=new DatabaseSync(source,{readOnly:true});
try{
  await backup(db,target);
  const copy=new DatabaseSync(target,{readOnly:true});
  try{if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup integrity check failed.');}
  finally{copy.close();}
  console.log(`Verified SQLite backup: ${target}`);
}finally{db.close();}
