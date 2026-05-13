import pytest
import respx

from desktop.rag.embeddings import EmbedError, OllamaEmbedder


@pytest.mark.asyncio
async def test_embed_success():
    embedder = OllamaEmbedder(base_url="http://localhost:11434", model="bge-m3")
    fake_embedding = [0.1] * 1024
    with respx.mock(base_url="http://localhost:11434") as mock:
        mock.post("/api/embed").respond(
            json={"embeddings": [fake_embedding]}
        )
        result = await embedder.embed("hello")
        assert result == fake_embedding


@pytest.mark.asyncio
async def test_embed_404_raises():
    embedder = OllamaEmbedder(base_url="http://localhost:11434", model="missing-model")
    with respx.mock(base_url="http://localhost:11434") as mock:
        mock.post("/api/embed").respond(404, json={"error": "model not found"})
        with pytest.raises(EmbedError) as exc:
            await embedder.embed("hello")
        assert exc.value.kind == "model_not_found"


@pytest.mark.asyncio
async def test_embed_500_raises():
    embedder = OllamaEmbedder(base_url="http://localhost:11434", model="bge-m3")
    with respx.mock(base_url="http://localhost:11434") as mock:
        mock.post("/api/embed").respond(500)
        with pytest.raises(EmbedError) as exc:
            await embedder.embed("hello")
        assert exc.value.kind == "upstream_error"


@pytest.mark.asyncio
async def test_embed_connection_error():
    embedder = OllamaEmbedder(base_url="http://nonexistent.invalid", model="bge-m3")
    with pytest.raises(EmbedError) as exc:
        await embedder.embed("hello")
    assert exc.value.kind in ("network", "unavailable")
