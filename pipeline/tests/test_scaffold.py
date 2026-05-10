"""Smoke test: verifies the package tree is importable. Deleted once real tests land."""


def test_packages_importable() -> None:
    """Ensure the package skeleton is importable (no syntax errors, no missing deps)."""
    import desktop  # noqa: F401
    import pi  # noqa: F401
