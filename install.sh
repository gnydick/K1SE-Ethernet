#!/bin/sh
# USB ethernet for the Creality K1 SE - installer.
#
# Run this on the printer, from a checkout of this repo:
#
#     cd /usr/data && git clone https://github.com/gnydick/K1SE-Ethernet.git
#     cd K1SE-Ethernet && sh install.sh
#
# Usage: sh install.sh [install|uninstall|status] [--force] [--no-load]
#
#   install     copy the modules and the two /etc files into place and load them
#   uninstall   remove them again (does not unload; reboot to finish)
#   status      report what is installed, what is loaded, and the eth0 state
#
#   --force     install even though this kernel is not the one the modules were
#               built for. They will only load if the vermagic matches exactly.
#   --no-load   copy the files but do not load the modules this boot.

SRC=$(cd "$(dirname "$0")" && pwd)

MODDIR=/usr/data/k1se-eth
INITD=/etc/init.d/S13usb_ethernet
UDEV=/etc/udev/rules.d/70-usb-ethernet.rules
MANIFEST=$SRC/modules/MANIFEST.md5

# The build these modules were made for and tested on.
TESTED_BUILD='#392'

ACTION=
FORCE=0
NOLOAD=0

die() {
	echo "install.sh: $*" 1>&2
	exit 1
}

usage() {
	# the header comment above, minus the #! line and the leading hashes
	awk 'NR > 1 { if (substr($0, 1, 1) != "#") exit; sub(/^# ?/, ""); print }' "$0"
	exit ${1:-0}
}

# vermagic of a shipped module, e.g. "4.4.94 SMP preempt mod_unload MIPS32_R2 32BIT"
module_vermagic() {
	if [ -x /usr/bin/strings ] || command -v strings > /dev/null 2>&1; then
		strings "$1" | grep -m1 '^vermagic=' | sed 's/^vermagic=//'
	else
		tr -c '[:print:]' '\n' < "$1" | grep -m1 '^vermagic=' | sed 's/^vermagic=//'
	fi
}

check_kernel() {
	ko=$SRC/modules/mii.ko
	[ -f "$ko" ] || die "$ko is missing - is this a complete checkout of the repo?"

	vm=$(module_vermagic "$ko")
	[ -n "$vm" ] || die "could not read the vermagic out of $ko"

	built_for=$(echo "$vm" | awk '{print $1}')
	running=$(uname -r)
	build=$(uname -v | awk '{print $1}')

	if [ "$built_for" != "$running" ]; then
		echo "  kernel:   $running   (modules are built for $built_for)" 1>&2
		[ "$FORCE" = 1 ] || die "this kernel is not the one the modules were built for.
  The kernel refuses a module whose vermagic differs, so these would not load.
  Rebuild them for $running (see README, Build), or re-run with --force."
		echo "  --force given, continuing anyway" 1>&2
	elif [ "$build" != "$TESTED_BUILD" ]; then
		echo "  kernel:   $running $build   (tested on $running $TESTED_BUILD)" 1>&2
		[ "$FORCE" = 1 ] || die "same kernel version but a different build than this was tested on.
  The vermagic matches, so the modules will most likely load and work.
  Re-run with --force to go ahead."
		echo "  --force given, continuing anyway" 1>&2
	else
		echo "  kernel:   $running $build   (matches what the modules were built for)"
	fi
}

preflight() {
	[ "$(id -u)" = 0 ] || die "must run as root (you are uid $(id -u))"
	[ "$(uname -m)" = mips ] || die "this is a MIPS build for the K1 SE; this machine is $(uname -m)"
	[ -f /etc/init.d/rcS ] || die "no /etc/init.d/rcS - this does not look like the printer's rootfs"
	[ -d /usr/data ] || die "no /usr/data - this does not look like the printer's rootfs"
	[ -f "$MANIFEST" ] || die "$MANIFEST is missing - is this a complete checkout of the repo?"
	echo "  running as root on $(uname -m), /usr/data present"
	check_kernel
}

# Write a file by way of a temporary name, so a copy that runs out of space
# cannot truncate the copy that is already installed and working.
install_file() {
	cp "$1" "$2.new" || die "could not write $2.new (is the filesystem full?) - $2 was left as it was"
	chmod "$3" "$2.new" || die "could not chmod $2.new"
	mv "$2.new" "$2" || die "could not put $2.new in place as $2"
	echo "  $2"
}

do_install() {
	echo "Preflight:"
	preflight

	# Was the driver already running before we touched anything? If it was, the
	# boot script will not re-insert it, and a caller who just updated the
	# modules needs to know the new code is not what is running.
	already_loaded=no
	grep -q '^cdc_ncm ' /proc/modules && already_loaded=yes

	echo "Modules -> $MODDIR:"
	mkdir -p "$MODDIR" || die "could not create $MODDIR"
	stage=$MODDIR/.staging
	rm -rf "$stage"
	mkdir -p "$stage" || die "could not create $stage"
	cp "$SRC"/modules/*.ko "$stage"/ || {
		rm -rf "$stage"
		die "could not copy the modules into $stage (is /usr/data full?) - anything already installed was left alone"
	}
	( cd "$stage" && md5sum -c "$MANIFEST" ) || {
		rm -rf "$stage"
		die "a staged module did not match modules/MANIFEST.md5 - nothing was replaced"
	}
	for f in "$stage"/*.ko; do
		mv "$f" "$MODDIR"/ || die "could not move $(basename "$f") into $MODDIR"
	done
	rm -rf "$stage"

	echo "Boot files:"
	install_file "$SRC/install/S13usb_ethernet" "$INITD" 755
	install_file "$SRC/install/70-usb-ethernet.rules" "$UDEV" 644
	udevadm control --reload-rules > /dev/null 2>&1 && echo "  udev rules reloaded"

	if [ "$NOLOAD" = 1 ]; then
		echo "Not loading the modules (--no-load); they will load at the next boot."
	elif [ "$already_loaded" = yes ]; then
		echo "Already loaded, so nothing was inserted."
		echo "  If you just updated the modules, reboot to run the new ones -"
		echo "  the copies on disk are new, the code in the kernel is not."
	else
		echo "Loading now:"
		sh "$INITD" start || die "the boot script could not load the modules (see the line above).
  The files are in place, so a reboot will try again."
	fi

	echo
	do_status
	echo
	if [ -d /sys/class/net/eth0 ]; then
		echo "Done. eth0 is present; /etc/network/interfaces and ifplugd take it from here."
	else
		echo "Done. Plug the dongle in - udev renames it to eth0 and DHCP runs by itself."
	fi
}

do_uninstall() {
	[ "$(id -u)" = 0 ] || die "must run as root"
	echo "Removing:"
	for f in "$INITD" "$UDEV"; do
		if [ -f "$f" ]; then
			rm -f "$f" && echo "  $f"
		else
			echo "  $f (was not there)"
		fi
	done
	if [ -d "$MODDIR" ]; then
		rm -rf "$MODDIR" && echo "  $MODDIR"
	else
		echo "  $MODDIR (was not there)"
	fi
	echo
	echo "The modules stay loaded until you reboot - unloading them now would drop"
	echo "this session if you came in over eth0. Reboot when convenient."
}

do_status() {
	echo "Installed:"
	for f in "$INITD" "$UDEV"; do
		[ -f "$f" ] && echo "  $f" || echo "  $f   MISSING"
	done
	if [ -d "$MODDIR" ]; then
		echo "  $MODDIR ($(ls "$MODDIR" | wc -l) files)"
	else
		echo "  $MODDIR   MISSING"
	fi

	echo "Loaded:"
	for m in mii usbnet cdc_ncm; do
		if grep -q "^$m " /proc/modules; then
			echo "  $m"
		else
			echo "  $m   not loaded"
		fi
	done

	echo "Network:"
	if [ -d /sys/class/net/eth0 ]; then
		echo "  eth0 operstate $(cat /sys/class/net/eth0/operstate), carrier $(cat /sys/class/net/eth0/carrier 2>/dev/null || echo '-')"
		ifconfig eth0 2>/dev/null | grep 'inet addr' | sed 's/^ */  /'
	elif [ -d /sys/class/net/usb0 ]; then
		echo "  usb0 exists but was not renamed to eth0 - check $UDEV"
	else
		echo "  no eth0 and no usb0 - is the dongle plugged in?"
	fi
}

while [ $# -gt 0 ]; do
	case "$1" in
		install|uninstall|status)
			ACTION=$1
			;;
		--force)
			FORCE=1
			;;
		--no-load)
			NOLOAD=1
			;;
		-h|--help)
			usage 0
			;;
		*)
			echo "install.sh: unknown argument '$1'" 1>&2
			usage 2
			;;
	esac
	shift
done

case "${ACTION:-install}" in
	install)
		do_install
		;;
	uninstall)
		do_uninstall
		;;
	status)
		do_status
		;;
esac
exit 0
