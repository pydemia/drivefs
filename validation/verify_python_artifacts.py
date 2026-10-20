"""Install built wheels in fresh environments and run public API smoke checks."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "validation" / "python_package_smoke.py"
EXTERNAL = {
    "gdrive": ["httpx>=0.28,<1"],
    "microsoft": ["httpx>=0.28,<1"],
    "fsspec": ["fsspec>=2024.12,<2027"],
}


def wheel(directory: Path, distribution: str) -> Path:
    matches = list(directory.glob(f"{distribution}-*.whl"))
    if len(matches) != 1:
        raise SystemExit(
            f"expected one {distribution} wheel in {directory}, found {len(matches)}"
        )
    return matches[0]


def run(command: list[str], cwd: Path, env: dict[str, str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def verify(wheel_dir: Path) -> None:
    wheels = {
        "core": wheel(wheel_dir, "drivefs"),
        "gdrive": wheel(wheel_dir, "drivefs_gdrive"),
        "microsoft": wheel(wheel_dir, "drivefs_microsoft"),
        "fsspec": wheel(wheel_dir, "drivefs_fsspec"),
    }
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    cases = {
        "core": ["core"],
        "gdrive": ["core", "gdrive"],
        "microsoft": ["core", "microsoft"],
        "fsspec": ["core", "fsspec"],
        "full": ["core", "gdrive", "microsoft", "fsspec"],
    }
    with tempfile.TemporaryDirectory(prefix="drivefs-python-wheels-") as temporary:
        base = Path(temporary)
        for case, selected in cases.items():
            directory = base / case
            directory.mkdir()
            environment = directory / "venv"
            venv.EnvBuilder(with_pip=True).create(environment)
            python = (
                environment / "Scripts" / "python.exe"
                if os.name == "nt"
                else environment / "bin" / "python"
            )
            external = sorted(
                {
                    requirement
                    for name in selected
                    for requirement in EXTERNAL.get(name, [])
                }
            )
            if external:
                run([str(python), "-m", "pip", "install", *external], directory, env)
            requested = [str(wheels[name]) for name in selected if name != "core"]
            if not requested:
                requested = [str(wheels["core"])]
            run(
                [
                    str(python),
                    "-m",
                    "pip",
                    "install",
                    "--no-index",
                    "--find-links",
                    str(wheel_dir),
                    *requested,
                ],
                directory,
                env,
            )
            run([str(python), "-m", "pip", "check"], directory, env)
            arguments = ["isolated", case] if case in EXTERNAL else [case]
            run([str(python), "-I", str(SMOKE), *arguments], directory, env)


def build(wheel_dir: Path) -> None:
    wheel_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    for name in ("core", "gdrive", "microsoft", "fsspec"):
        run(
            [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--wheel-dir",
                str(wheel_dir),
                str(ROOT / "python" / "packages" / name),
            ],
            ROOT,
            env,
        )


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--build":
        directory = Path(sys.argv[2]).resolve()
        build(directory)
    elif len(sys.argv) == 2:
        directory = Path(sys.argv[1]).resolve(strict=True)
    else:
        raise SystemExit("usage: verify_python_artifacts.py [--build] WHEEL_DIR")
    verify(directory)
