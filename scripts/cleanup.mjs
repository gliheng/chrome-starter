import os from "os";
import path from "path";
import moment from 'moment';
import fs from 'node:fs/promises';

const tmpDir = path.join(
  os.tmpdir(),
  moment().subtract(1, 'day').format("YYYY-MM-DD"),
);

console.log('Removing dir: ', tmpDir);

fs.rm(tmpDir, { recursive: true, force: true }).then(() => {
  console.log('Dir removed');
}).catch((err) => {
  console.error(err);
});
