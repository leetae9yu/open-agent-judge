import unittest

from solution import candidate


class CandidateTest(unittest.TestCase):
    def test_sums_unique_values(self):
        self.assertEqual(candidate([1, 2, 2, 3]), 6)

    def test_handles_negative_values(self):
        self.assertEqual(candidate([-1, -1, 2, 4]), 5)

    def test_empty_list(self):
        self.assertEqual(candidate([]), 0)


if __name__ == "__main__":
    unittest.main()
