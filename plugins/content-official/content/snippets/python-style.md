# Python style

- Add type hints to public functions, methods, and module-level values whose type is not obvious.
- Model optional and union values explicitly instead of relying on implicit `None` handling.
- Run Ruff formatting and lint checks using the repository's configuration.
- Fix lint findings at their source instead of adding blanket ignores.
- Keep imports ordered and remove unused imports.
- Prefer small typed interfaces over loosely structured dictionaries at module boundaries.
