import json
import unittest
from pathlib import Path

from python_programs.lis import lis


class QuixBugsTest(unittest.TestCase):
    def test_official_cases(self):
        cases = [
            json.loads(line)
            for line in (Path(__file__).parent / "cases.json").read_text(encoding="utf-8").splitlines()
        ]
        for input_data, expected in cases:
            with self.subTest(input_data=input_data):
                self.assertEqual(lis(*input_data), expected)


if __name__ == "__main__":
    unittest.main()
