import { describe, expect, it } from 'vitest';
import {
    parseListV2Xml,
    resolveAddressStyle,
    S3Client,
} from '../S3Client';
import {
    buildMediaKey,
    mediaCategoryFor,
    publicUrlFor,
    sanitizeFileName,
} from '../MediaUploadHandler';
import {
    decideSyncAction,
    hasHiddenSegment,
    mirrorPrefixFor,
    normalizeFolderPath,
} from '../FolderSyncService';
import type { LocalEntry, RemoteEntry } from '../FolderSyncService';

// ── S3Client XML parsing ───────────────────────────────────────────────────

describe('parseListV2Xml', () => {
    it('extracts objects with size and last-modified', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>Cloud/a.md</Key><Size>42</Size><LastModified>2026-08-01T10:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>Cloud/sub/b.png</Key><Size>1024</Size><LastModified>2026-08-02T11:30:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;
        const parsed = parseListV2Xml(xml);
        expect(parsed.nextContinuationToken).toBeNull();
        expect(parsed.objects).toHaveLength(2);
        expect(parsed.objects[0]).toMatchObject({ key: 'Cloud/a.md', size: 42 });
        expect(parsed.objects[0].lastModifiedMs).toBe(Date.parse('2026-08-01T10:00:00.000Z'));
        expect(parsed.objects[1].key).toBe('Cloud/sub/b.png');
    });

    it('decodes XML entities in keys', () => {
        const xml = `<ListBucketResult><Contents><Key>a &amp; b &lt;c&gt;.md</Key>` +
            `<Size>1</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>`;
        const parsed = parseListV2Xml(xml);
        expect(parsed.objects[0]?.key).toBe('a & b <c>.md');
    });

    it('reads the continuation token when truncated', () => {
        const xml = `<ListBucketResult><IsTruncated>true</IsTruncated>` +
            `<NextContinuationToken>next-token/1+2</NextContinuationToken>` +
            `<Contents><Key>x.txt</Key><Size>7</Size></Contents></ListBucketResult>`;
        const parsed = parseListV2Xml(xml);
        expect(parsed.nextContinuationToken).toBe('next-token/1+2');
        expect(parsed.objects).toHaveLength(1);
    });

    it('returns empty results for an empty bucket listing', () => {
        const parsed = parseListV2Xml('<ListBucketResult></ListBucketResult>');
        expect(parsed.objects).toEqual([]);
        expect(parsed.nextContinuationToken).toBeNull();
    });
});

describe('S3Client request URL building', () => {
    // Exercised through a cast so the signing math stays observable without
    // network I/O. buildSignedUrl is intentionally deterministic except for
    // the timestamp fields.
    function signedUrl(key: string, query?: Map<string, string>): string {
        const client = new S3Client({
            endpoint: 'https://s3.eu-central-1.amazonaws.com',
            region: 'eu-central-1',
            bucket: 'my-bucket',
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: 'secret',
        });
        interface Builder {
            buildSignedUrl: (
                method: 'GET' | 'PUT' | 'DELETE',
                key: string,
                query?: Map<string, string>,
            ) => { url: string };
        }
        return (client as unknown as Builder).buildSignedUrl('GET', key, query).url;
    }

    it('builds path-style URLs with encoded keys', () => {
        const url = signedUrl('Cloud/my note (v2).md');
        expect(url.startsWith('https://s3.eu-central-1.amazonaws.com/my-bucket/Cloud/')).toBe(true);
        expect(url).toContain('my%20note%20%28v2%29.md');
        expect(url.includes('?')).toBe(false);
    });

    it('encodes query parameters RFC3986-style and sorted', () => {
        const url = signedUrl('', new Map<string, string>([
            ['prefix', 'Cloud/sub dir'],
            ['list-type', '2'],
        ]));
        expect(url.endsWith('?list-type=2&prefix=Cloud%2Fsub%20dir')).toBe(true);
    });

    it('switches to virtual-host addressing for Tencent COS endpoints', () => {
        const client = new S3Client({
            endpoint: 'https://cos.ap-guangzhou.myqcloud.com',
            region: 'ap-guangzhou',
            bucket: 'obs-1330552791',
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: 'secret',
        });
        interface Builder {
            buildSignedUrl: (method: 'GET', key: string) => { url: string };
        }
        const url = (client as unknown as Builder).buildSignedUrl('GET', 'a/b.png').url;
        expect(url.startsWith('https://obs-1330552791.cos.ap-guangzhou.myqcloud.com/')).toBe(true);
        expect(url).not.toContain('/obs-1330552791/');
    });

    it('keeps path-style for non-COS endpoints unless overridden', () => {
        expect(resolveAddressStyle('s3.eu-central-1.amazonaws.com')).toBe('path');
        expect(resolveAddressStyle('cos.ap-guangzhou.myqcloud.com')).toBe('virtual');
        expect(resolveAddressStyle('mybucket.oss-cn-hangzhou.aliyuncs.com')).toBe('path');
        expect(resolveAddressStyle('s3.eu-central-1.amazonaws.com', 'virtual')).toBe('virtual');
    });
});

// ── Media upload helpers ───────────────────────────────────────────────────

describe('sanitizeFileName', () => {
    it('strips path components and unsafe characters', () => {
        expect(sanitizeFileName('C:\\Users\\me\\vacation photo!.png')).toBe('vacation-photo-.png');
        expect(sanitizeFileName('/tmp/weird:name*?.mov')).toBe('weird-name-.mov');
    });

    it('falls back to "file" for degenerate input', () => {
        expect(sanitizeFileName('///')).toBe('file');
        expect(sanitizeFileName('')).toBe('file');
    });

    it('keeps safe names untouched', () => {
        expect(sanitizeFileName('screenshot_2026-08-27.png')).toBe('screenshot_2026-08-27.png');
    });
});

describe('buildMediaKey', () => {
    const ts = Date.UTC(2026, 7, 27, 12, 0, 0);

    it('composes category/date/timestamp structure', () => {
        expect(buildMediaKey('obsidian/media', 'My Photo.png', ts, 'image/png'))
            .toBe(`obsidian/media/images/20260827/${ts}-my-photo.png`);
        expect(buildMediaKey('obsidian/media', 'clip.mp4', ts, 'video/mp4'))
            .toContain('video/');
        expect(buildMediaKey('obsidian/media', 'voice memo.mp3', ts, 'audio/mpeg'))
            .toContain('audio/');
    });

    it('falls back to extension and files/ for unknown types', () => {
        expect(buildMediaKey('p', 'notes.pdf', ts)).toContain('/files/');
        expect(buildMediaKey('p', 'x.jpg', ts, '')).toContain('/images/');
    });
});

describe('mediaCategoryFor', () => {
    it('classifies by mime first, then extension, then files/', () => {
        expect(mediaCategoryFor('image/png', 'a.bin')).toBe('images');
        expect(mediaCategoryFor('', 'song.flac')).toBe('audio');
        expect(mediaCategoryFor(undefined, 'movie.mov')).toBe('video');
        expect(mediaCategoryFor('application/pdf', 'doc.pdf')).toBe('files');
    });
});

describe('publicUrlFor', () => {
    it('joins base URL and per-segment encoded key', () => {
        expect(publicUrlFor('https://cdn.example.com/', 'media/2026/a b.png'))
            .toBe('https://cdn.example.com/media/2026/a%20b.png');
        expect(publicUrlFor('https://bucket.s3.amazonaws.com', 'x/y.mp4'))
            .toBe('https://bucket.s3.amazonaws.com/x/y.mp4');
    });
});

// ── Folder sync decision logic ─────────────────────────────────────────────

describe('normalizeFolderPath', () => {
    it('trims slashes and rejects root', () => {
        expect(normalizeFolderPath('/Cloud/')).toBe('Cloud');
        expect(normalizeFolderPath(' Cloud ')).toBe('Cloud');
        expect(normalizeFolderPath('/')).toBe('');
        expect(normalizeFolderPath('')).toBe('');
    });
});

describe('mirrorPrefixFor', () => {
    it('defaults to the folder name', () => {
        expect(mirrorPrefixFor('Notes/Articles')).toBe('Articles');
        expect(mirrorPrefixFor('Cloud')).toBe('Cloud');
    });

    it('falls back to vault/ for whole-vault mode', () => {
        expect(mirrorPrefixFor('')).toBe('vault');
    });

    it('honours an explicit override', () => {
        expect(mirrorPrefixFor('Cloud', 'obsidian-backup/notes')).toBe('obsidian-backup/notes');
    });
});

describe('hasHiddenSegment', () => {
    it('flags dot-prefixed path segments', () => {
        expect(hasHiddenSegment('.obsidian/plugins/x')).toBe(true);
        expect(hasHiddenSegment('Cloud/.trash/y')).toBe(true);
        expect(hasHiddenSegment('Cloud/a/.DS_Store')).toBe(true);
        expect(hasHiddenSegment('Cloud/plain/file.md')).toBe(false);
    });
});

describe('decideSyncAction', () => {
    const local = (size: number, mtimeMs: number): LocalEntry =>
        ({ relPath: 'a.md', size, mtimeMs });
    const remote = (size: number, lastModifiedMs: number): RemoteEntry =>
        ({ relPath: 'a.md', size, lastModifiedMs });

    it('uploads local-only files', () => {
        expect(decideSyncAction(local(10, 100), null)).toBe('upload');
    });

    it('downloads remote-only files', () => {
        expect(decideSyncAction(null, remote(10, 100))).toBe('download');
    });

    it('skips files identical within clock skew', () => {
        expect(decideSyncAction(local(10, 5_000), remote(10, 5_500))).toBe('skip');
        expect(decideSyncAction(local(10, 100), remote(10, 100))).toBe('skip');
    });

    it('does not skip equal-mtime files whose sizes differ', () => {
        expect(decideSyncAction(local(11, 100), remote(10, 100))).not.toBe('skip');
    });

    it('prefers the newer side on conflicts', () => {
        expect(decideSyncAction(local(10, 9_999), remote(5, 100))).toBe('upload');
        expect(decideSyncAction(local(5, 100), remote(10, 9_999))).toBe('download');
    });
});
