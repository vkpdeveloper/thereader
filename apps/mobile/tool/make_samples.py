#!/usr/bin/env python3
"""Deterministically generate three original sample EPUBs for The Reader's sample mode.

Output: assets/samples/<id>.epub and assets/samples/manifest.json (sizes + sha256).
The books are original short texts written for this project.
"""
import hashlib, json, os, zipfile, io

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "samples")
FIXED_TIME = (2026, 9, 22, 0, 0, 0)

CSS = """
body { margin: 0; padding: 0; }
h1 { font-weight: 600; font-size: 1.6em; margin: 0 0 1.2em; }
h2 { font-weight: 600; font-size: 1.2em; margin: 1.6em 0 0.8em; }
p { margin: 0 0 1em; line-height: 1.55; }
p.first::first-letter { font-size: 1.1em; }
blockquote { margin: 1.2em 1.4em; font-style: italic; }
hr { border: 0; text-align: center; margin: 1.6em 0; }
"""

BOOKS = [
  {
    "id": "the-quiet-hour",
    "title": "The Quiet Hour",
    "author": "The Reader",
    "description": "An original short reading sample about the hour before the house wakes.",
    "subjects": ["Essays"],
    "chapters": [
      ("Before the Kettle", [
        "There is an hour before the house wakes that belongs to no one. The radiator ticks. The window holds a square of grey that is not yet light. If you sit still enough, the room forgets you are in it.",
        "I have learned to keep a chair by the east window for exactly this. Nothing is decided in the quiet hour. Letters are not answered. The list on the fridge stays a list. The only work is the slow work of noticing that the day has not begun.",
        "Most mornings the kettle spoils it. The click of the switch is a small verdict: the ordinary has been resumed. But a few mornings the water takes so long to boil that the hour stretches, and I am given a little more of the nothing I came for.",
      ]),
      ("The Shape of a Page", [
        "A page is a room with two walls. The margins keep the words from wandering off, and the words keep the margins honest. I think about this when a book is set badly; the eye can feel a crooked wall before the mind finds a name for it.",
        "Good typography is a kind of hospitality. It does not announce itself. It moves the chair a little closer to the fire and then leaves.",
        "When I read on a screen I want the same courtesy. Black behind the words, so the light of the page does not fight the light of the room. A measure of sixty characters or so. Enough leading that a line can breathe out before the next one breathes in.",
      ]),
      ("What the Hour Is For", [
        "People ask what the quiet hour is for, as if silence needed a job. I used to invent answers. Planning. Reflection. Now I say it is for nothing, and I try to mean it.",
        "The truth is that the hour does its work on me whether I assign it a purpose or not. By the time the light has climbed from the sill to the table, I am someone slightly slower and slightly kinder than the person who sat down.",
        "That is all. The kettle clicks. The house wakes. I carry the hour into the rest of the day like a stone in a coat pocket, and touch it when I need to remember.",
      ]),
    ],
  },
  {
    "id": "a-walk-in-the-rain",
    "title": "A Walk in the Rain",
    "author": "The Reader",
    "description": "An original short story about a walk that goes on longer than planned.",
    "subjects": ["Fiction"],
    "chapters": [
      ("Umbrella", [
        "Mara had decided against the umbrella at the door, and by the corner she had already forgiven herself for it. The rain was the fine, patient kind that does not fall so much as arrive.",
        "She had meant to go to the shop and back. Milk, a lemon, whatever bread looked least tired. But the street was empty in a way that made walking feel like a permission, and she took the long way round the park.",
        "The path was silver where the light caught it. A dog with no visible owner trotted past with the air of an errand. Mara put her hands in her pockets and matched its pace for no reason she could have explained.",
      ]),
      ("The Bench", [
        "Halfway around the pond there is a bench that faces the wrong way. Everyone who sits on it looks at a hedge instead of the water, and everyone who sits on it stays longer than they meant to.",
        "Mara sat. Rain gathered on the slats and soaked through the knees of her jeans and she found she did not mind. A heron stood in the shallows behind her, motionless, a grey punctuation mark at the end of a sentence she could not read.",
        "She thought about the milk. She thought about the lemon. She thought about the year that had folded itself up and gone, and about how little of it she could remember in order. Then she stopped thinking, which was the point of the bench.",
      ]),
      ("Bread", [
        "By the time she reached the shop the rain had eased to a suggestion. The bell above the door rang. The man behind the counter looked at her hair and said nothing, kindly.",
        "The bread was tired. She bought it anyway, and the milk, and a lemon that was very nearly perfect. On the walk back she found she was humming, and did not stop.",
        "At the door she looked at the umbrella in its stand and left it there, so that next time there would be a reason to be surprised.",
      ]),
    ],
  },
  {
    "id": "notes-on-attention",
    "title": "Notes on Attention",
    "author": "The Reader",
    "description": "Original short notes on reading slowly and paying attention.",
    "subjects": ["Essays", "Reading"],
    "chapters": [
      ("One Thing", [
        "Attention is not a resource. It is a direction. You cannot save it up, but you can point it, and where you point it becomes the shape of your day.",
        "A book asks for one thing. Not for your whole self, only for one thread of it, held steady for the length of a paragraph. That is a smaller ask than it sounds and a larger gift than it seems.",
      ]),
      ("The Slow Page", [
        "Read slowly enough that you can hear the sentence. Every writer has a breath, and every sentence is a length of it. When you read at speed you are listening to someone talk with the sound off.",
        "This is why the page matters. If the words are cramped the breath is cramped. If the light is harsh the reader squints and the squint becomes the tone of the book.",
        "Give the words room. Give yourself room. Nothing is lost by finishing tomorrow.",
      ]),
      ("Keeping Place", [
        "A bookmark is a promise. It says: I was here, and I intend to return. The best readers I know keep their promises badly and their books well.",
        "Progress is not a percentage. It is the feeling of a chapter settling into you, which happens at its own speed and is not improved by measuring.",
        "Still, keep your place. Keep it locally, keep it quietly, and keep it without ceremony, so that the next quiet hour can begin where the last one left off.",
      ]),
    ],
  },
]

def xhtml(title, paras):
    body = "\n".join(
        f'<p class="{"first" if i == 0 else ""}">{p}</p>' for i, p in enumerate(paras)
    )
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><meta charset="utf-8"/><title>{title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="chapter"><h1>{title}</h1>
{body}
</section></body></html>
"""

def build(book):
    bid = book["id"]
    chapters = book["chapters"]
    manifest_items = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                      '<item id="css" href="style.css" media-type="text/css"/>']
    spine = []
    files = {}
    for i, (title, paras) in enumerate(chapters, 1):
        name = f"chapter-{i}.xhtml"
        files[f"OEBPS/{name}"] = xhtml(title, paras)
        manifest_items.append(f'<item id="c{i}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="c{i}"/>')
    nav_items = "\n".join(f'<li><a href="chapter-{i}.xhtml">{t}</a></li>' for i, (t, _) in enumerate(chapters, 1))
    files["OEBPS/nav.xhtml"] = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
{nav_items}
</ol></nav></body></html>
"""
    files["OEBPS/style.css"] = CSS
    subjects = "\n".join(f"<dc:subject>{s}</dc:subject>" for s in book["subjects"])
    files["OEBPS/content.opf"] = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:thereader:{bid}</dc:identifier>
<dc:title>{book["title"]}</dc:title>
<dc:creator>{book["author"]}</dc:creator>
<dc:language>en</dc:language>
<dc:description>{book["description"]}</dc:description>
{subjects}
<meta property="dcterms:modified">2026-09-22T00:00:00Z</meta>
</metadata>
<manifest>
{chr(10).join(manifest_items)}
</manifest>
<spine>
{chr(10).join(spine)}
</spine>
</package>
"""
    files["META-INF/container.xml"] = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        zi = zipfile.ZipInfo("mimetype", FIXED_TIME)
        z.writestr(zi, "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        for name in sorted(files):
            zi = zipfile.ZipInfo(name, FIXED_TIME)
            z.writestr(zi, files[name], compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()

def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for book in BOOKS:
        data = build(book)
        path = os.path.join(OUT, f'{book["id"]}.epub')
        with open(path, "wb") as f:
            f.write(data)
        manifest.append({
            "id": book["id"], "version": "1", "title": book["title"], "author": book["author"],
            "description": book["description"], "language": "en", "subjects": book["subjects"],
            "coverUrl": None, "downloadUrl": f'/v1/books/{book["id"]}/download',
            "fileSize": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "updatedAt": "2026-09-22T00:00:00.000Z",
        })
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump({"items": manifest, "nextCursor": None}, f, indent=2)
        f.write("\n")
    for m in manifest:
        print(m["id"], m["fileSize"], m["sha256"])

if __name__ == "__main__":
    main()
