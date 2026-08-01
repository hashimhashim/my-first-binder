import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vmconvert import core  # noqa: E402


class BuildCommandTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(core, "qemu_img", return_value="qemu-img")
        self.addCleanup(patcher.stop)
        patcher.start()

    def test_vmdk_defaults_to_monolithic_sparse(self):
        cmd = core.build_command("in.vhd", "out.vmdk", "vmdk")
        self.assertIn("-O", cmd)
        self.assertEqual(cmd[cmd.index("-O") + 1], "vmdk")
        self.assertIn("subformat=monolithicSparse", cmd)
        self.assertEqual(cmd[-2:], ["in.vhd", "out.vmdk"])

    def test_source_format_is_pinned_when_known(self):
        cmd = core.build_command("in.img", "out.qcow2", "qcow2", src_format="raw")
        self.assertEqual(cmd[cmd.index("-f") + 1], "raw")

    def test_vdi_has_no_subformat_option(self):
        cmd = core.build_command("in.vhd", "out.vdi", "vdi")
        self.assertNotIn("-o", cmd)

    def test_bad_subformat_rejected(self):
        with self.assertRaises(core.ConversionError):
            core.build_command("in.vhd", "out.vmdk", "vmdk", subformat="nonsense")

    def test_unknown_target_rejected(self):
        with self.assertRaises(core.ConversionError):
            core.build_command("in.vhd", "out.xyz", "xyz")

    def test_compression_limited_to_qcow2_and_vmdk(self):
        self.assertIn("-c", core.build_command("in.img", "o.qcow2", "qcow2", compress=True))
        with self.assertRaises(core.ConversionError):
            core.build_command("in.img", "o.vdi", "vdi", compress=True)


class SourceChecks(unittest.TestCase):
    def test_acronis_tib_gets_a_two_step_hint(self):
        with mock.patch("os.path.isfile", return_value=True):
            with self.assertRaises(core.ConversionError) as ctx:
                core.check_source("backup.tib")
        self.assertIn("Mount Image", str(ctx.exception))

    def test_missing_file(self):
        with self.assertRaises(core.ConversionError):
            core.check_source("/definitely/not/here.vhd")


class ProgressParsing(unittest.TestCase):
    def test_reads_percentages_across_chunks(self):
        seen = []
        core._read_progress(["    (1.23/100%)\r  (45.6", "7/100%)\r (100.00/100%)\r"], seen.append)
        self.assertEqual(seen, [1.23, 45.67, 100.0])


class Helpers(unittest.TestCase):
    def test_default_output_path_swaps_extension(self):
        self.assertEqual(core.default_output_path("/data/disk.vhd", "vmdk"), "/data/disk.vmdk")
        self.assertEqual(core.default_output_path("/data/disk.vhd", "vpc"), "/data/disk.vhd")

    def test_human_size(self):
        self.assertEqual(core.human_size(512), "512 B")
        self.assertEqual(core.human_size(2 * 1024**3), "2.0 GiB")


if __name__ == "__main__":
    unittest.main()
