import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** Media types the Messages API accepts as an image block. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } };

/**
 * Splits a data URL into its media type and payload.
 * Returns undefined for anything that isn't a base64 image data URL.
 */
export function parseImageDataUrl(
  dataUrl: string
): { mediaType: ImageMediaType; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return undefined;

  const declared = match[1].toLowerCase();
  // image/jpg is common in the wild but not a real media type.
  const mediaType = declared === 'image/jpg' ? 'image/jpeg' : declared;
  if (!IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType)) return undefined;

  return { mediaType: mediaType as ImageMediaType, data: match[2] };
}

/**
 * Builds the streaming-input message for a turn.
 *
 * Images ride along as native content blocks. The agent reads them directly,
 * so there is no temp file to write, reference in the prompt, or clean up.
 */
export function buildUserMessage(text: string, images?: string[]): SDKUserMessage {
  const imageBlocks: ContentBlock[] = [];

  for (const dataUrl of images ?? []) {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) continue;
    imageBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
    });
  }

  // With no images, send the plain string the CLI itself writes.
  const content: ContentBlock[] | string =
    imageBlocks.length === 0
      ? text
      // Text last so the images it refers to are already in context.
      : text
        ? [...imageBlocks, { type: 'text', text }]
        : imageBlocks;

  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    session_id: '',
  } as unknown as SDKUserMessage;
}
