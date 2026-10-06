"""Runs trafilatura over the eval manifest and times parse and extraction separately.

uv run python run_trafilatura.py <manifest.json> <out.json> [--runs N] [--workers N]

Settings: trafilatura defaults except include_comments=False, as in the Zyte
benchmark's own runner (comments are not article body). Text output is scored;
an untimed second call with output_format="xml" and with_metadata=True feeds the
title and the structure stats (its HTML output renders inline code as <pre>, so
code blocks cannot be counted from it).
"""

import argparse
import json
import time
from importlib.metadata import version
from multiprocessing import Pool

import trafilatura
from lxml import etree
from trafilatura.utils import load_html

RUNS = 5
INLINE_PARENTS = {"p", "head", "hi", "ref", "item", "cell", "quote"}


def stats(root):
    if root is None:
        return {"codeBlocks": 0, "codeLanguages": [], "images": 0, "headings": 0, "tables": 0, "lists": 0,
                "math": 0, "footnotes": 0, "footnoteRefs": 0, "embeds": 0}
    code = [c for c in root.iter("code") if c.getparent().tag not in INLINE_PARENTS or "\n" in (c.text or "").strip()]
    return {
        "codeBlocks": len(code),
        "codeLanguages": [],
        "images": len(list(root.iter("graphic"))),
        "headings": len([h for h in root.iter("head") if h.get("rend") in ("h2", "h3", "h4", "h5", "h6")]),
        "tables": len(list(root.iter("table"))),
        "lists": len(list(root.iter("list"))),
        "math": 0,
        "footnotes": 0,
        "footnoteRefs": 0,
        "embeds": 0,
    }


def run(doc):
    with open(doc["path"], encoding="utf-8") as f:
        html = f.read()
    result = {"ok": True, "parseMs": [], "extractMs": []}
    try:
        result["text"] = trafilatura.extract(load_html(html), url=doc["url"], include_comments=False) or ""
        xml = trafilatura.extract(
            load_html(html), url=doc["url"], include_comments=False, output_format="xml", with_metadata=True
        )
        root = etree.fromstring(xml.encode("utf-8")) if xml else None
        result["title"] = root.get("title", "") if root is not None else ""
        result["stats"] = stats(root)
        for _ in range(RUNS):
            t0 = time.perf_counter()
            tree = load_html(html)
            t1 = time.perf_counter()
            trafilatura.extract(tree, url=doc["url"], include_comments=False)
            t2 = time.perf_counter()
            result["parseMs"].append((t1 - t0) * 1000)
            result["extractMs"].append((t2 - t1) * 1000)
    except Exception as error:
        result = {"ok": False, "error": f"{type(error).__name__}: {error}", "parseMs": [], "extractMs": []}
    return doc["id"], result


def init(runs):
    global RUNS
    RUNS = runs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("out")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    with open(args.manifest, encoding="utf-8") as f:
        docs = json.load(f)
    with Pool(args.workers, initializer=init, initargs=(args.runs,)) as pool:
        results = dict(pool.imap_unordered(run, docs))
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"version": version("trafilatura"), "results": results}, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
