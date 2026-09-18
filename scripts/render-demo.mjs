#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = join(root, '.dev/launch');
const media = join(root, 'docs/media');
const { start, end, marks } = JSON.parse(readFileSync(join(raw, 'demo-timeline.json'), 'utf8'));
mkdirSync(media, { recursive: true });
mkdirSync(join(raw, 'captions'), { recursive: true });
const run = (args) => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}`);
};
const encoders =
  spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
const codec = encoders.includes('libx264')
  ? ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20']
  : ['-c:v', 'libopenh264', '-b:v', '4000k'];
const captions = marks.map((mark, index) => {
  const file = `.dev/launch/captions/${index}.txt`;
  writeFileSync(join(root, file), mark.text);
  const from = Math.max(0, mark.at - start);
  const to = (marks[index + 1]?.at ?? end) - start;
  return `drawtext=font='DejaVu Sans':textfile='${file}':fontcolor=0xe8edf4:fontsize=27:x=52:y=1021:enable='between(t,${from},${to})'`;
});
const filters = [
  'pad=1440:1080:0:96:color=0x101720',
  'drawbox=x=0:y=90:w=iw:h=3:color=0x62dcc5:t=fill',
  "drawtext=font='DejaVu Sans':text='vsdiff':fontcolor=0x62dcc5:fontsize=40:x=48:y=23",
  "drawtext=font='DejaVu Sans':text='A route through the diff':fontcolor=0xe8edf4:fontsize=23:x=218:y=36",
  ...captions,
];
run([
  '-ss',
  String(start),
  '-i',
  '.dev/launch/demo.webm',
  '-t',
  String(end - start),
  '-vf',
  filters.join(','),
  ...codec,
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  '-an',
  'docs/media/vsdiff-demo.mp4',
]);
run([
  '-i',
  'docs/media/vsdiff-demo.mp4',
  '-vf',
  'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  '-loop',
  '0',
  'docs/media/demo.gif',
]);
const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const vtt = marks
  .map(
    (mark, i) =>
      `${stamp(Math.max(0, mark.at - start))} --> ${stamp((marks[i + 1]?.at ?? end) - start)}\n${mark.text}`,
  )
  .join('\n\n');
writeFileSync(join(media, 'vsdiff-demo.vtt'), `WEBVTT\n\n${vtt}\n`);
console.log('Rendered docs/media/vsdiff-demo.mp4, demo.gif, and captions.');
