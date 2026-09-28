import tempfile
import unittest
from pathlib import Path

from release_poster import check_spec, chinese_release_section, scan, wrap_lines


class ReleasePosterTest(unittest.TestCase):
    def test_latest_semver_and_chinese_credits(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            notes = repo / "release-notes"
            notes.mkdir()
            (notes / "v0.6.9.md").write_text("# ccmax v0.6.9\n本次版本修复桌面端加载问题 **@latest-user**\n<details>\n@english-only\n", encoding="utf-8")
            (notes / "v0.6.8.md").write_text("# ccmax v0.6.8\n本次版本修复桌面端加载问题 **@old-user**\n", encoding="utf-8")
            result = scan(repo)
            self.assertEqual(result["version"], "0.6.9")
            self.assertEqual([person["login"] for person in result["mentions"]], ["latest-user"])
            older = scan(repo, "v0.6.8")
            self.assertEqual(older["version"], "0.6.8")
            self.assertEqual([person["login"] for person in older["mentions"]], ["old-user"])

    def test_current_release_v0_6_7_scans_offline(self):
        # Directed regression for the shipped `# ccmax vX.Y.Z` heading: copy the
        # real release note into a throwaway, non-git repo so scan runs with no
        # git refs and no GitHub access.
        source = Path(__file__).resolve().parents[4] / "release-notes" / "v0.6.7.md"
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            notes = repo / "release-notes"
            notes.mkdir()
            (notes / "v0.6.7.md").write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
            result = scan(repo)
        self.assertEqual(result["version"], "0.6.7")
        self.assertEqual(result["source"], "working-tree")
        self.assertIn("侧边对话", result["chinese_markdown"])
        self.assertNotIn("Side chats", result["chinese_markdown"])
        self.assertNotIn("This release adds", result["chinese_markdown"])
        candidates = {person["login"]: person["credit_candidate"] for person in result["mentions"]}
        self.assertIs(candidates.get("yuehua-meng"), True)

    def test_chinese_section_in_either_order_and_without_details(self):
        # Both the current `# ccmax vX.Y.Z` heading and the historical upstream
        # `# Claude Code Haha vX.Y.Z` heading must split the two languages.
        for title in ("# ccmax v0.5.4\n", "# Claude Code Haha v0.5.4\n"):
            english_first = title + "English changes here.\n<details>\n<summary>中文版本</summary>\n" + title + "这里是中文修复内容和版本更新。\n</details>"
            chinese_first = title + "这里是中文修复内容和版本更新。\n<details>\n<summary>English</summary>\n" + title + "English changes here.\n</details>"
            no_details = title + "这里是中文修复内容和版本更新。\n" + title + "English changes here.\n"
            for markdown in (english_first, chinese_first, no_details):
                selected = chinese_release_section(markdown)
                self.assertIn("这里是中文修复内容", selected)
                self.assertNotIn("English changes", selected)

    def test_incidental_mention_is_not_contributor_credit(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            notes = repo / "release-notes"
            notes.mkdir()
            (notes / "v0.2.0.md").write_text(
                "# ccmax v0.2.0\n本次修复桌面问题。\n- PR 模板默认要求 @dosubot review。\n- 修复连接问题 **@actual-author**（#42）。\n",
                encoding="utf-8",
            )
            result = scan(repo)
            candidates = {person["login"]: person["credit_candidate"] for person in result["mentions"]}
            self.assertEqual(candidates, {"dosubot": False, "actual-author": True})
            spec = {
                "version": "0.2.0", "features": [], "fixes": [{"title": "修复", "body": "说明"}],
                "contributors": [{"login": "dosubot", "contribution": "代码贡献"}],
            }
            with self.assertRaisesRegex(ValueError, "未在 release note 中文部分明确署名"):
                check_spec(spec, result)

    def test_cannot_credit_unmentioned_account(self):
        source = {"version": "0.6.7", "mentions": [{"login": "actual-author", "credit_candidate": True}]}
        spec = {
            "version": "0.6.7",
            "features": [{"title": "功能", "body": "说明"}],
            "fixes": [{"title": "修复", "body": "说明"}],
            "contributors": [{"login": "different-author", "contribution": "贡献"}],
        }
        with self.assertRaisesRegex(ValueError, "未在 release note 中文部分明确署名"):
            check_spec(spec, source)

    def test_offline_avatar_requires_explicit_test_mode(self):
        source = {"version": "0.6.7", "mentions": [{"login": "actual-author", "credit_candidate": True}]}
        spec = {
            "version": "0.6.7", "features": [], "fixes": [{"title": "修复", "body": "说明"}],
            "contributors": [{"login": "actual-author", "contribution": "修复", "avatar_path": "fake.png"}],
        }
        with self.assertRaisesRegex(ValueError, "仅供显式离线测试"):
            check_spec(spec, source)
        check_spec(spec, source, allow_offline_avatars=True)

    def test_chinese_punctuation_does_not_start_a_wrapped_line(self):
        width = 4
        measure = len
        for value in ("这是测试；继续", "这是测试。继续", "这是测试、继续", "测试「功能描述"):
            lines = wrap_lines(value, width, measure)
            self.assertTrue(all(not line.startswith(("；", "。", "、")) for line in lines[1:]))
            self.assertTrue(all(not line.endswith("「") for line in lines[:-1]))


if __name__ == "__main__":
    unittest.main()
