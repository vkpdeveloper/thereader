import re, struct, zlib, hashlib, sys, json
IMAGE_EXT = ('.jpg','.jpeg','.png','.webp','.gif','.avif','.bmp')
def is_page(name):
    n = name.replace('\\','/')
    segs = n.split('/')
    if n.endswith('/') or any(s.startswith('.') or s == '__MACOSX' for s in segs if s): return False
    return n.lower().endswith(IMAGE_EXT)
def chunks(s):
    return re.findall(r'\d+|\D+', s)
def key(name):
    out = []
    for c in chunks(name.lower()):
        if c.isdigit():
            v = c.lstrip('0') or '0'
            out.append((0, len(v), v, len(c)))
        else:
            out.append((1, c))
    return out
def cmp(a, b):
    ka, kb = key(a), key(b)
    for x, y in zip(ka, kb):
        if x[0] != y[0]: return -1 if x[0] < y[0] else 1   # digits sort before text
        if x != y: return -1 if x < y else 1
    if len(ka) != len(kb): return -1 if len(ka) < len(kb) else 1
    return -1 if a < b else (1 if a > b else 0)
import functools
def page_order(names):
    return sorted([n for n in names if is_page(n)], key=functools.cmp_to_key(cmp))
def pack(entries):  # entries: dict name -> bytes (names already '/'-normalized)
    pages = page_order(list(entries))
    infos = sorted([n for n in entries if n.split('/')[-1].lower() == 'comicinfo.xml'], key=lambda n: (n.count('/'), n))
    order = pages + infos[:1]
    local = bytearray(); central = bytearray()
    for name in order:
        data = entries[name]; nb = name.encode('utf-8'); crc = zlib.crc32(data) & 0xffffffff
        off = len(local)
        local += struct.pack('<IHHHHHIIIHH', 0x04034b50, 10, 0x0800, 0, 0, 0x0021, crc, len(data), len(data), len(nb), 0) + nb + data
        central += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 10, 10, 0x0800, 0, 0, 0x0021, crc, len(data), len(data), len(nb), 0, 0, 0, 0, 0, off) + nb
    eocd = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(order), len(order), len(central), len(local), 0)
    return bytes(local + central + eocd), pages
if __name__ == '__main__':
    entries = {
        'Comic/ComicInfo.xml': b'<?xml version="1.0"?><ComicInfo><Series>Vector</Series></ComicInfo>',
        'Comic/page10.jpg': b'\xff\xd8\xff ten',
        'Comic/page2.JPG': b'\xff\xd8\xff two',
        'Comic/page02b.png': b'\x89PNG two-b',
        'Comic/Cover.webp': b'RIFF cover',
        'Comic/__MACOSX/._page2.jpg': b'junk',
        'Comic/.hidden.jpg': b'hidden',
        'Comic/notes.txt': b'notes',
        'Comic/extras/001.jpg': b'\xff\xd8\xff extra',
    }
    sort_vectors = ['p1.jpg','p01.jpg','p001.jpg','p2.jpg','p10.jpg','P3.jpg','a/p9.jpg','a/p10.jpg','b/p1.jpg','cover.jpg','x 2.jpg','x 10.jpg']
    data, pages = pack(entries)
    print(json.dumps({'pages': pages, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data),
        'sorted': page_order(sort_vectors)}, indent=1))
