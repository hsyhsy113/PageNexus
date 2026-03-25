#!/usr/bin/env python3
"""
Local embedding runner for PageNexus.
Input (stdin JSON): {"texts": ["...", "..."]}
Output (stdout JSON): {"embeddings": [[...], [...]]}
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, List, Tuple


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local embedding model and output vectors as JSON.")
    parser.add_argument("--model", required=True, help="HuggingFace model id, e.g. google/embeddinggemma-300m")
    parser.add_argument(
        "--server",
        action="store_true",
        help="Run as long-lived JSONL server: each stdin line is a JSON request with {id,texts}",
    )
    return parser.parse_args()


def _sanitize_text(text: str) -> str:
    # 关键逻辑：去除可能触发 tokenizer 异常的非法代理字符，并做基础规整。
    safe = text.encode("utf-8", "replace").decode("utf-8", "replace")
    return " ".join(safe.split())


def _normalize_item(item: Any) -> str:
    if item is None:
        return ""
    if isinstance(item, str):
        return _sanitize_text(item)
    if isinstance(item, (int, float, bool)):
        return _sanitize_text(str(item))
    # 关键逻辑：复杂类型先转 JSON，保证输入稳定可序列化再参与 embedding。
    if isinstance(item, (dict, list, tuple)):
        return _sanitize_text(json.dumps(item, ensure_ascii=False))
    return _sanitize_text(str(item))


def load_payload() -> List[str]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("stdin is empty, expected JSON with field 'texts'")
    payload = json.loads(raw)
    texts = payload.get("texts")
    if not isinstance(texts, list):
        raise ValueError("payload.texts must be a list")
    normalized = [_normalize_item(item) for item in texts]
    if not normalized:
        raise ValueError("payload.texts is empty")
    return normalized


def _encode_batch(model: Any, texts: List[str]) -> List[List[float]]:
    vectors = model.encode(
        texts,
        batch_size=min(32, len(texts)),
        show_progress_bar=False,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    return vectors.tolist()


def _encode_with_fallback(model: Any, texts: List[str]) -> Tuple[List[List[float]], int]:
    """
    返回 (vectors, fallback_count)
    fallback_count 表示触发逐条/兜底编码的次数，用于调试和质量监控。
    """
    try:
        return _encode_batch(model, texts), 0
    except Exception:
        fallback_count = 0
        vectors: List[List[float]] = []
        for text in texts:
            safe_text = text if text else " "
            try:
                vectors.extend(_encode_batch(model, [safe_text]))
            except Exception:
                fallback_count += 1
                # 兜底文本，保证向量数量与输入一致，避免整批重建失败。
                vectors.extend(_encode_batch(model, ["[invalid-text]"]))
        return vectors, fallback_count


def main() -> int:
    args = parse_args()

    # 关键逻辑：本地加载 SentenceTransformer，并用 normalize_embeddings 输出可直接做余弦相似度的向量。
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(args.model, trust_remote_code=True)
    if not args.server:
        texts = load_payload()
        vectors, fallback_count = _encode_with_fallback(model, texts)
        if len(vectors) != len(texts):
            raise RuntimeError(
                f"local embedder internal mismatch: vectors={len(vectors)} texts={len(texts)}"
            )

        result = {"embeddings": vectors, "fallback_count": fallback_count}
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0

    # 关键逻辑：服务模式下复用单个模型实例，按行处理请求，避免重复加载模型。
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        request_id = None
        try:
            payload = json.loads(raw)
            request_id = payload.get("id")
            texts = payload.get("texts")
            if not isinstance(texts, list):
                raise ValueError("payload.texts must be a list")
            normalized = [_normalize_item(item) for item in texts]
            if not normalized:
                raise ValueError("payload.texts is empty")
            vectors, fallback_count = _encode_with_fallback(model, normalized)
            if len(vectors) != len(normalized):
                raise RuntimeError(
                    f"local embedder internal mismatch: vectors={len(vectors)} texts={len(normalized)}"
                )
            response = {
                "id": request_id,
                "embeddings": vectors,
                "fallback_count": fallback_count,
            }
        except Exception as error:
            response = {
                "id": request_id,
                "error": str(error),
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(str(error))
        raise
