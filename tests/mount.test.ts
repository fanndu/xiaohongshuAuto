import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountCollector, ProfileDocumentNotReadyError } from '../src/app/mount';
import { FloatingControl } from '../src/ui/floating-control';

describe('mountCollector', () => {
  afterEach(() => {
    document.querySelector('#xhs-profile-collector')?.remove();
    vi.restoreAllMocks();
  });

  it('rolls back a partially mounted control when initial rendering throws', () => {
    vi.spyOn(FloatingControl.prototype, 'render').mockImplementation(() => { throw new Error('render'); });
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { userId: 'alice', basicInfo: {}, interactions: [], notes: [] } },
    })};</script>`;

    expect(() => mountCollector('https://www.xiaohongshu.com/user/profile/alice')).toThrow('render');
    expect(document.querySelector('#xhs-profile-collector')).toBeNull();
  });

  it('refuses a Bob route while explicit Alice structured state is still present, without accepting Bob DOM content', () => {
    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { userId: 'alice', basicInfo: { nickname: 'Alice' }, interactions: [], notes: [{ id: 'alice-note' }] } },
    })};</script><section data-testid="profile-header"><span data-testid="user-name">Bob</span><img data-testid="avatar" src="https://img.example/bob.jpg"></section><article class="note-item"><a href="/explore/bob-note"></a></article>`;
    const createControl = vi.fn();

    expect(() => mountCollector('https://www.xiaohongshu.com/user/profile/bob', undefined, { createControl }))
      .toThrow(ProfileDocumentNotReadyError);
    expect(createControl).not.toHaveBeenCalled();
    expect(document.querySelector('#xhs-profile-collector')).toBeNull();
  });

  it('refuses a blank profile route before creating UI, while accepting a matching structured zero-note profile', () => {
    const createControl = vi.fn(() => ({ destroy: vi.fn(), render: vi.fn() }));
    document.body.innerHTML = '';

    expect(() => mountCollector('https://www.xiaohongshu.com/user/profile/alice', undefined, { createControl }))
      .toThrow(ProfileDocumentNotReadyError);
    expect(createControl).not.toHaveBeenCalled();

    document.body.innerHTML = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({
      user: { userPageData: { userId: 'alice', basicInfo: {}, interactions: [], notes: [] } },
    })};</script>`;
    const cleanup = mountCollector('https://www.xiaohongshu.com/user/profile/alice', undefined, { createControl });
    expect(createControl).toHaveBeenCalledOnce();
    cleanup();
  });

  it('accepts a recognized DOM-only zero-note profile when structured identity is absent', () => {
    document.body.innerHTML = '<section data-testid="profile-header"><span data-testid="user-name">Alice</span></section>';
    const control = { destroy: vi.fn(), render: vi.fn() };
    const cleanup = mountCollector('https://www.xiaohongshu.com/user/profile/alice', undefined, {
      createControl: () => control,
    });

    expect(control.render).toHaveBeenCalledWith({ phase: 'ready' });
    cleanup();
  });
});
