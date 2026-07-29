from __future__ import annotations

import unittest

from elysium.utils.time_format import format_duration


class TimeFormatTests(unittest.TestCase):
    def test_examples(self) -> None:
        cases = {
            0: "0 segundos",
            60: "1 minuto",
            12 * 60: "12 minutos",
            65 * 60: "1 hora e 5 minutos",
            (2 * 24 * 60 + 3 * 60 + 8) * 60: "2 dias, 3 horas e 8 minutos",
        }
        for seconds, expected in cases.items():
            with self.subTest(seconds=seconds):
                self.assertEqual(format_duration(seconds), expected)
