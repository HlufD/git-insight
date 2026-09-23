import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALIAS_FILE_PATH, AliasFileError, acceptGroup, dissolveGroup, emptyAliasFile, pairKey, parseAliasFile,
  readAliasFile, rejectMembers, removeFromGroup, renameGroup, serializeAliasFile, writeAliasFile,
} from '../../src/stats/aliasFile';

describe('parseAliasFile', () => {
  it('round-trips a valid file', () => {
    const file = acceptGroup(emptyAliasFile(), ['a <a@x>', 'b <b@x>'], 'A', 'a@x');
    expect(parseAliasFile(serializeAliasFile(file))).toEqual(file);
  });

  it('fills in missing arrays and removes duplicate members', () => {
    expect(parseAliasFile('{"version":1}')).toEqual(emptyAliasFile());
    expect(parseAliasFile('{"version":1,"groups":[{"name":"A","email":"a","members":["x","x"]}]}').groups[0]!.members).toEqual(['x']);
  });

  it.each([
    ['not json', /not valid JSON/],
    ['[]', /JSON object/],
    ['{"version":2}', /unsupported version 2/],
    ['{"version":1,"groups":{}}', /"groups" must be an array/],
    ['{"version":1,"groups":[{"name":"A"}]}', /groups\[0\]/],
    ['{"version":1,"rejected":[["a"]]}', /"rejected"/],
  ])('rejects %s', (text, message) => {
    expect(() => parseAliasFile(text)).toThrow(AliasFileError);
    expect(() => parseAliasFile(text)).toThrow(message);
  });
});

describe('alias file edits', () => {
  it('accepting merges overlapping groups and clears their rejections', () => {
    let file = acceptGroup(emptyAliasFile(), ['a', 'b'], 'A', 'a@x');
    file = rejectMembers(file, ['b', 'c']);
    file = acceptGroup(file, ['b', 'c'], 'B', 'b@x');
    expect(file.groups).toEqual([{ name: 'B', email: 'b@x', members: ['a', 'b', 'c'] }]);
    expect(file.rejected).toEqual([]);
  });

  it('rejecting skips duplicates and pairs already confirmed together', () => {
    let file = acceptGroup(emptyAliasFile(), ['a', 'b'], 'A', 'a@x');
    file = rejectMembers(file, ['b', 'a', 'c']);
    file = rejectMembers(file, ['c', 'a']);
    expect(file.rejected.map(([x, y]) => pairKey(x, y)).sort()).toEqual([pairKey('a', 'c'), pairKey('b', 'c')].sort());
  });

  it('removes, renames and dissolves groups', () => {
    let file = acceptGroup(emptyAliasFile(), ['a', 'b', 'c'], 'A', 'a@x');
    file = acceptGroup(file, ['d', 'e'], 'D', 'd@x');
    file = removeFromGroup(file, 0, 'c');
    expect(file.groups[0]!.members).toEqual(['a', 'b']);
    file = renameGroup(file, 0, 'Alpha', 'alpha@x');
    expect(file.groups[0]).toMatchObject({ name: 'Alpha', email: 'alpha@x' });
    file = removeFromGroup(file, 1, 'e');
    expect(file.groups).toHaveLength(1);
    expect(dissolveGroup(file, 0).groups).toEqual([]);
  });
});

describe('reading and writing', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gi-alias-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as empty and persists rejections across reads', async () => {
    expect(await readAliasFile(dir)).toEqual(emptyAliasFile());
    const file = rejectMembers(emptyAliasFile(), ['x <x@a>', 'y <y@b>']);
    await writeAliasFile(dir, file);
    expect(await readAliasFile(dir)).toEqual(file);
    expect(await readFile(path.join(dir, ALIAS_FILE_PATH), 'utf8')).toMatch(/\n$/);
  });

  it('surfaces read errors other than a missing file', async () => {
    await mkdir(path.join(dir, ALIAS_FILE_PATH), { recursive: true });
    await expect(readAliasFile(dir)).rejects.toThrow();
    await rm(path.join(dir, ALIAS_FILE_PATH), { recursive: true });
    await writeFile(path.join(dir, ALIAS_FILE_PATH), '{"version":9}');
    await expect(readAliasFile(dir)).rejects.toThrow(AliasFileError);
  });
});
