import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { avatarImageInfo, avatarDimensions, AVATAR_INPUT_LIMIT } from '../src/components/muse/avatar-upload.ts';

test('avatar headers accept actual supported formats and EXIF orientation before decode', async () => {
  for (const format of ['png', 'jpeg', 'webp', 'gif']) {
    const bytes = await sharp({create:{width:800,height:1200,channels:4,background:'#8ea9cc'}})[format]().toBuffer();
    assert.deepEqual(avatarImageInfo(bytes, bytes.length), {width:800,height:1200,type:'image/'+format});
  }
  const rotated = await sharp({create:{width:2400,height:1200,channels:3,background:'#dfcfaf'}}).withMetadata({orientation:6}).jpeg().toBuffer();
  assert.deepEqual(avatarImageInfo(rotated,rotated.length),{width:1200,height:2400,type:'image/jpeg'});
});
test('avatar sizing preserves portrait/landscape proportions and never enlarges small images', () => {
  assert.deepEqual(avatarDimensions(6000,4000),{width:1600,height:1067});
  assert.deepEqual(avatarDimensions(4000,6000),{width:1067,height:1600});
  assert.deepEqual(avatarDimensions(96,64),{width:96,height:64});
});
test('unsupported, truncated and excessive inputs fail the bounded header check', async () => {
  for(const bytes of [Buffer.from('<svg/>'),Buffer.from('GIF'),Buffer.from([255,216,255,225,255,255])]) assert.throws(()=>avatarImageInfo(bytes,bytes.length));
  const png=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();
  assert.throws(()=>avatarImageInfo(png,AVATAR_INPUT_LIMIT+1));
  png.writeUInt32BE(9000,16);png.writeUInt32BE(9000,20);
  assert.throws(()=>avatarImageInfo(png,png.length));
  png.writeUInt32BE(16385,16);png.writeUInt32BE(1,20);
  assert.throws(()=>avatarImageInfo(png,png.length));
});
