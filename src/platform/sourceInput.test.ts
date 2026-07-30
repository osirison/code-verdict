import { describe, expect, it } from 'vitest';
import { parseSourceInput } from './sourceInput';

describe('parseSourceInput (handoff §4)', () => {
  it('strips origin from a full URL', () => {
    expect(parseSourceInput('https://gitlab.com/hve/platform/core')).toEqual({
      shape: 'path',
      path: 'hve/platform/core',
    });
  });

  it('drops the /-/… suffix and .git', () => {
    expect(parseSourceInput('https://gitlab.com/hve/platform/core/-/merge_requests/2841')).toEqual({
      shape: 'path',
      path: 'hve/platform/core',
    });
    expect(parseSourceInput('https://gitlab.com/hve/platform/core.git')).toEqual({
      shape: 'path',
      path: 'hve/platform/core',
    });
  });

  it('treats all-digits as an id', () => {
    expect(parseSourceInput('9102')).toEqual({ shape: 'id', id: '9102' });
  });

  it('recognises the group prefix and /groups/ paths', () => {
    expect(parseSourceInput('group 4821')).toEqual({ shape: 'groupId', id: '4821' });
    expect(parseSourceInput('GROUP: 4821')).toEqual({ shape: 'groupId', id: '4821' });
    expect(parseSourceInput('https://gitlab.com/groups/hve/platform')).toEqual({
      shape: 'groupPath',
      path: 'hve/platform',
    });
  });

  it('accepts a bare path', () => {
    expect(parseSourceInput('hve/platform/core')).toEqual({ shape: 'path', path: 'hve/platform/core' });
  });

  it('never resolves garbage', () => {
    expect(parseSourceInput('')).toEqual({ shape: 'invalid' });
    expect(parseSourceInput('   ')).toEqual({ shape: 'invalid' });
    expect(parseSourceInput('what is this')).toEqual({ shape: 'invalid' });
    expect(parseSourceInput('https://')).toEqual({ shape: 'invalid' });
  });
});
