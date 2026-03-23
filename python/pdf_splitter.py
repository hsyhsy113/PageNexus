#!/usr/bin/env python3
import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path


MIN_TARGET_PAGES = 40


@dataclass
class Chunk:
    chunk_id: str
    file_name: str
    page_start: int
    page_end: int
    page_count: int
    local_pdf_path: str
    size_bytes: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Split PDF into MinerU-friendly chunks.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--file-stem", required=True)
    parser.add_argument("--target-bytes", type=int, required=True)
    parser.add_argument("--max-bytes", type=int, required=True)
    parser.add_argument("--max-pages", type=int, required=True)
    parser.add_argument("--target-pages", type=int, required=True)
    return parser.parse_args()


def count_pages_with_fitz(source: Path) -> int:
    import fitz

    with fitz.open(source) as document:
        return len(document)


def save_chunk_with_fitz(source: Path, start_page: int, end_page: int, target: Path) -> int:
    import fitz

    with fitz.open(source) as source_document:
        out = fitz.open()
        out.insert_pdf(source_document, from_page=start_page - 1, to_page=end_page - 1)
        out.save(target, garbage=4, deflate=True, clean=True)
        out.close()
    return target.stat().st_size


def count_pages_with_pypdf(source: Path) -> int:
    from pypdf import PdfReader

    reader = PdfReader(str(source))
    return len(reader.pages)


def save_chunk_with_pypdf(source: Path, start_page: int, end_page: int, target: Path) -> int:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(source))
    writer = PdfWriter()
    for page_index in range(start_page - 1, end_page):
        writer.add_page(reader.pages[page_index])
    with target.open("wb") as handle:
        writer.write(handle)
    return target.stat().st_size


def choose_backend(source: Path):
    try:
        import fitz  # noqa: F401

        return count_pages_with_fitz, save_chunk_with_fitz, "fitz"
    except Exception:
        try:
            import pypdf  # noqa: F401

            return count_pages_with_pypdf, save_chunk_with_pypdf, "pypdf"
        except Exception as error:
            raise RuntimeError(
                "No PDF backend found. Install PyMuPDF (fitz) or pypdf in the Python runtime."
            ) from error


def compute_target_pages(page_count: int, file_size: int, requested_target_pages: int, target_bytes: int, max_pages: int) -> int:
    if page_count <= 0:
        return max(1, requested_target_pages)
    average = max(1, file_size // page_count)
    estimate = target_bytes // average
    target = max(MIN_TARGET_PAGES, int(estimate))
    target = min(target, requested_target_pages, max_pages)
    return max(1, target)


def chunk_filename(file_stem: str, chunk_id: str) -> str:
    return f"{file_stem}-{chunk_id}.pdf"


def make_chunk(
    source: Path,
    output_dir: Path,
    file_stem: str,
    index: int,
    start_page: int,
    end_page: int,
    save_chunk,
) -> Chunk:
    chunk_id = f"part-{index:03d}-p{start_page}-{end_page}"
    file_name = chunk_filename(file_stem, chunk_id)
    target = output_dir / file_name
    size_bytes = save_chunk(source, start_page, end_page, target)
    return Chunk(
        chunk_id=chunk_id,
        file_name=file_name,
        page_start=start_page,
        page_end=end_page,
        page_count=(end_page - start_page + 1),
        local_pdf_path=str(target.resolve()),
        size_bytes=size_bytes,
    )


def create_chunks(args: argparse.Namespace) -> list[Chunk]:
    source = Path(args.source).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    count_pages, save_chunk, _backend = choose_backend(source)
    page_count = count_pages(source)
    if page_count <= 0:
        raise RuntimeError("PDF has no pages.")

    file_size = source.stat().st_size
    target_pages = compute_target_pages(
        page_count=page_count,
        file_size=file_size,
        requested_target_pages=args.target_pages,
        target_bytes=args.target_bytes,
        max_pages=args.max_pages,
    )

    chunks: list[Chunk] = []
    oversized: list[Chunk] = []
    index = 1
    start = 1

    while start <= page_count:
        end = min(start + target_pages - 1, page_count, start + args.max_pages - 1)
        chunk = make_chunk(
            source=source,
            output_dir=output_dir,
            file_stem=args.file_stem,
            index=index,
            start_page=start,
            end_page=end,
            save_chunk=save_chunk,
        )
        if chunk.size_bytes > args.max_bytes:
            oversized.append(chunk)
        else:
            chunks.append(chunk)
        index += 1
        start = end + 1

    while oversized:
        parent = oversized.pop()
        parent_path = Path(parent.local_pdf_path)
        parent_size = parent_path.stat().st_size if parent_path.exists() else parent.size_bytes
        if parent_size <= args.max_bytes:
            chunks.append(parent)
            continue
        if parent.page_count <= 1:
            raise RuntimeError(
                f"Single-page chunk still exceeds max size: {parent.file_name} ({parent_size} bytes)"
            )

        if parent_path.exists():
            parent_path.unlink()

        midpoint = parent.page_start + (parent.page_count // 2) - 1
        for sub_start, sub_end in ((parent.page_start, midpoint), (midpoint + 1, parent.page_end)):
            sub_chunk = make_chunk(
                source=source,
                output_dir=output_dir,
                file_stem=args.file_stem,
                index=index,
                start_page=sub_start,
                end_page=sub_end,
                save_chunk=save_chunk,
            )
            if sub_chunk.size_bytes > args.max_bytes:
                oversized.append(sub_chunk)
            else:
                chunks.append(sub_chunk)
            index += 1

    chunks.sort(key=lambda item: item.page_start)
    return chunks


def main() -> int:
    args = parse_args()
    try:
        chunks = create_chunks(args)
        payload = {
            "chunks": [
                {
                    "chunkId": chunk.chunk_id,
                    "fileName": chunk.file_name,
                    "pageStart": chunk.page_start,
                    "pageEnd": chunk.page_end,
                    "pageCount": chunk.page_count,
                    "localPdfPath": chunk.local_pdf_path,
                }
                for chunk in chunks
            ]
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as error:
        sys.stderr.write(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
