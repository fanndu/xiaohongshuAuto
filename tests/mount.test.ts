import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountCollector } from '../src/app/mount';
import { FloatingControl } from '../src/ui/floating-control';

describe('mountCollector', () => {
  afterEach(() => {
    document.querySelector('#xhs-profile-collector')?.remove();
    vi.restoreAllMocks();
  });

  it('rolls back a partially mounted control when initial rendering throws', () => {
    vi.spyOn(FloatingControl.prototype, 'render').mockImplementation(() => { throw new Error('render'); });

    expect(() => mountCollector('https://www.xiaohongshu.com/user/profile/alice')).toThrow('render');
    expect(document.querySelector('#xhs-profile-collector')).toBeNull();
  });
});
