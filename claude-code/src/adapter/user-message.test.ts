/**
 * Tests for buildUserMessage – images as native content blocks.
 */

import { buildUserMessage, parseImageDataUrl } from './user-message';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

type Content = Array<Record<string, unknown>> | string;
const contentOf = (text: string, images?: string[]): Content =>
  buildUserMessage(text, images).message.content as Content;

describe('parseImageDataUrl', () => {
  const cases: Array<{ name: string; input: string; want: unknown }> = [
    { name: 'png', input: PNG, want: { mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
    { name: 'jpeg', input: 'data:image/jpeg;base64,AAAA', want: { mediaType: 'image/jpeg', data: 'AAAA' } },
    { name: 'jpg normalizes to jpeg', input: 'data:image/jpg;base64,AAAA', want: { mediaType: 'image/jpeg', data: 'AAAA' } },
    { name: 'uppercase media type', input: 'data:IMAGE/PNG;base64,AAAA', want: { mediaType: 'image/png', data: 'AAAA' } },
    { name: 'gif', input: 'data:image/gif;base64,AAAA', want: { mediaType: 'image/gif', data: 'AAAA' } },
    { name: 'webp', input: 'data:image/webp;base64,AAAA', want: { mediaType: 'image/webp', data: 'AAAA' } },
    { name: 'leading whitespace tolerated', input: '  data:image/png;base64,AAAA', want: { mediaType: 'image/png', data: 'AAAA' } },
    { name: 'not a data url', input: '/tmp/foo.png', want: undefined },
    { name: 'missing base64 marker', input: 'data:image/png,AAAA', want: undefined },
    { name: 'empty payload', input: 'data:image/png;base64,', want: undefined },
    { name: 'unsupported media type', input: 'data:application/pdf;base64,AAAA', want: undefined },
    { name: 'svg is not accepted', input: 'data:image/svg+xml;base64,AAAA', want: undefined },
  ];

  it.each(cases)('$name', ({ input, want }) => {
    expect(parseImageDataUrl(input)).toEqual(want);
  });
});

describe('buildUserMessage', () => {
  it('sends plain text as a string when there are no images', () => {
    expect(contentOf('hello')).toBe('hello');
  });

  it('sends plain text as a string when every image is unparseable', () => {
    expect(contentOf('hello', ['/tmp/not-a-data-url.png'])).toBe('hello');
  });

  it('emits an image block followed by the text block', () => {
    expect(contentOf('what colour?', [PNG])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'what colour?' },
    ]);
  });

  it('keeps multiple images in order', () => {
    const content = contentOf('compare', [PNG, 'data:image/gif;base64,R0lG']);
    expect(content).toHaveLength(3);
    expect((content as Array<Record<string, unknown>>).map((b) => b.type)).toEqual(['image', 'image', 'text']);
  });

  it('drops only the unparseable images', () => {
    const content = contentOf('look', ['nonsense', PNG]);
    expect((content as Array<Record<string, unknown>>).map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('omits the text block when an image arrives with no caption', () => {
    expect(contentOf('', [PNG])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });

  it('marks the message as a top-level user turn', () => {
    const msg = buildUserMessage('hi');
    expect(msg.type).toBe('user');
    expect(msg.parent_tool_use_id).toBeNull();
  });
});
