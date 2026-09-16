# K1 SE USB Ethernet (UGREEN 20256 / ASIX AX88179B)

Loadable kernel modules for the Creality K1 SE stock kernel
(`Linux 4.4.94 #392 SMP PREEMPT`, Ingenic X2000, MIPS32r2 little-endian).
No kernel replacement.

## What the dongle is

UGREEN 20256 on this printer identifies as **ASIX AX88179B**, USB ID `0b95:1790`.
The stock kernel enumerates it in its **CDC-NCM** configuration (config 2,
interface class 02 / subclass 0d), so the natural driver is `cdc_ncm`, not the
ASIX vendor driver. `ax88179_178a.ko` is built as a fallback; it needs the
device switched to configuration 1 and must not be loaded at the same time as
`cdc_ncm` (both match the same VID:PID).

## Modules (`modules/`)

| file | depends on | role |
|---|---|---|
| `mii.ko` | – | MII helpers |
| `usbnet.ko` | mii | USB network framework (also exports `cdc_parse_cdc_header` in this tree) |
| `cdc_ncm.ko` | usbnet | **primary driver** for the NCM configuration |
| `cdc_ether.ko` | usbnet | CDC-ECM, built for completeness, not needed for this dongle |
| `ax88179_178a.ko` | usbnet, mii | vendor driver, fallback only |

`kernel.config` is the exact config the modules were built with.

Load order for a test (all in `/tmp`, nothing persisted):

    insmod /tmp/mii.ko && insmod /tmp/usbnet.ko && insmod /tmp/cdc_ncm.ko

## Verification done before loading

- vermagic `4.4.94 SMP preempt mod_unload MIPS32_R2 32BIT ` matches the
  stock modules in `/module_driver/` byte for byte.
- `.gnu.linkonce.this_module` (struct module) is 352 bytes in both ours and
  Creality's modules, so the module ABI layout agrees.
- All 152 undefined symbols resolve: 119 are exported by the printer kernel
  (checked against `__ksymtab_*` entries in its `/proc/kallsyms`), 33 are
  provided by our own modules.
- Kernel has no MODVERSIONS and no signature enforcement.
- ABI flags: MIPS32r2, o32, soft-float, same as the stock modules.

## Build

Source: Ingenic X2000 SDK kernel 4.4.94, GitHub mirror
`Jubian540/x2000_kernel` branch `x2000`, commit `7f14bc69e`.
Config: `arch/mips/configs/x2000_module_base_linux_mmc0_defconfig`
(printer reports machine `ingenic,x2000_module_base`, eMMC root) with
`USB_USBNET`, `MII`, `USB_NET_CDC_NCM`, `USB_NET_CDCETHER`,
`USB_NET_AX88179_178A` set to `m` and all other USB net minidrivers off.
Toolchain: Ingenic `mips-gcc720-glibc229` (gcc 7.2.0), from
https://github.com/ballaswag/k1-discovery/releases/download/1.0.0/mips-gcc720-glibc229.tar.gz

Two gotchas:

- Pass `LOCALVERSION=` (set but empty) on the make command line, otherwise
  `setlocalversion` appends `+` to the release and vermagic becomes `4.4.94+`.
- Build the `.ko` targets one at a time. Several single-module targets in one
  parallel make race in modpost and truncate `.mod.o` files.

Build tree lives on the Linux box at `~/k1se-eth/` with `build.sh` to rebuild.

## Installed on the printer (2026-09-15)

| on printer | from |
|---|---|
| `/usr/data/k1se-eth/*.ko` | `modules/` |
| `/etc/init.d/S13usb_ethernet` | `install/S13usb_ethernet` (insmod mii, usbnet, cdc_ncm; fallback rename) |
| `/etc/udev/rules.d/70-usb-ethernet.rules` | `install/70-usb-ethernet.rules` (renames usb0 to eth0) |

The two `/etc` files live in `/overlay/upper`, the modules on the `/usr/data`
partition. Creality's stock `/etc/network/interfaces` (`auto eth0`, dhcp) and
`/etc/ifplugd/ifplugd.conf` (`INTERFACES="eth0"`) are untouched and now apply
to the dongle because of the rename.

Result: eth0 at 1000 Mbit, DHCP lease obtained, 0% loss pinging the gateway
and from a PC on the LAN. `carrier_changes` stayed at 2 over 8 s (no flapping).
The udev rename was observed working on a live module reload
(`eth0: renamed from usb0`). Reboot test passed on k1se-1: with the dongle
attached, eth0 came up by itself at boot and obtained its lease.

Patch applied to the source tree: `patches/0001-cdc_ncm-quiet-link-notifications.patch`.
The AX88179B sends a link-status notification every 128 ms and stock 4.4
`cdc_ncm` logged each one at info level (about 8 dmesg lines per second).
The three log calls are now `netif_dbg`, as upstream did later. After the swap
the kernel log stayed silent over a 6 s window.

## Rollback

    rm /etc/init.d/S13usb_ethernet /etc/udev/rules.d/70-usb-ethernet.rules
    rm -r /usr/data/k1se-eth
    reboot

## Known limitations

- Hotplug after boot: on all three printers the dongle was first attached
  after the modules were loaded, and the whole chain ran unattended
  (usb0 created, udev renamed it eth0, ifplugd ran ifup, DHCP lease). The
  one manual `ifup eth0` on k1se-1 was during the very first test, before
  the install script existed. If eth0 ever has carrier but no address,
  `ifup eth0` is the fix.
- Do not use raw `wl down` / `wl up` on the Wi-Fi radio. On k1se-1 a
  `wl down wlan0` left the printer running but unreachable on both
  interfaces until reboot. Use Creality's `wifi_down.sh` / `wifi_up.sh`.
- Both wlan0 and eth0 get a default route; each DHCP client only replaces its
  own interface's default route. Disable Wi-Fi in the printer UI if a single
  path is wanted.
