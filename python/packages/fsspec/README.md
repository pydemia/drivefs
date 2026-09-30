# drivefs-fsspec

Read-only fsspec view of an existing `drivefs.FileStorage` instance. Install
this package only when an fsspec consumer needs it. The adapter has no provider
dependency and does not create or own credentials.

```python
from drivefs_fsspec import DriveFSFileSystem

fs = DriveFSFileSystem(storage=storage)  # an existing FileStorage instance
print(fs.ls("/reports", detail=True))
with fs.open("/reports/summary.bin", "rb") as reader:
    reader.seek(1024)
    chunk = reader.read(512)
```

Only binary reads are supported. Writes, moves, and deletes must use the
underlying `FileStorage` explicitly. The reader uses `read_range` and does not
download a full file simply to seek.
