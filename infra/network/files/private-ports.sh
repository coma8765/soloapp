#!/bin/sh
set -eu
if [ -x /opt/hack-vk-26/nodeports.sh ]; then /opt/hack-vk-26/nodeports.sh; fi
iptables -N SOLO_PRIVATE 2>/dev/null || true
iptables -F SOLO_PRIVATE
iptables -A SOLO_PRIVATE -i lo -j RETURN
iptables -A SOLO_PRIVATE -i wg-solo -j RETURN
iptables -A SOLO_PRIVATE -i cni0 -j RETURN
iptables -A SOLO_PRIVATE -i flannel.1 -j RETURN
iptables -A SOLO_PRIVATE -p tcp -m multiport --dports 6443,55432,55433,19080,19082 -j REJECT
iptables -A SOLO_PRIVATE -j RETURN
iptables -C INPUT -j SOLO_PRIVATE 2>/dev/null || iptables -I INPUT 1 -j SOLO_PRIVATE

# The monitor must not be reachable over public IPv6.
ip6tables -N SOLO_PRIVATE 2>/dev/null || true
ip6tables -F SOLO_PRIVATE
ip6tables -A SOLO_PRIVATE -i lo -j RETURN
ip6tables -A SOLO_PRIVATE -p tcp -m multiport --dports 6443,55432,55433,19080,19082 -j REJECT
ip6tables -C INPUT -j SOLO_PRIVATE 2>/dev/null || ip6tables -I INPUT 1 -j SOLO_PRIVATE

# Only root delivery agents and the OS Login SSH/NSS services may use metadata.
iptables -N SOLO_METADATA 2>/dev/null || true
iptables -F SOLO_METADATA
iptables -A SOLO_METADATA -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A SOLO_METADATA -m owner --uid-owner 0 -j RETURN
if id sshd >/dev/null 2>&1; then
  iptables -A SOLO_METADATA -m owner --uid-owner "$(id -u sshd)" -j RETURN
fi
# nscd performs OS Login NSS lookups under its configured service UID.
if [ -f /etc/nscd.conf ]; then
  nscd_user=$(awk '$1 == "server-user" {print $2}' /etc/nscd.conf | tail -n 1)
  if [ -n "$nscd_user" ]; then
    nscd_uid=$(id -u "$nscd_user")
    case "$nscd_uid" in 999|10001|10002|10003) echo "Refusing workload UID for nscd" >&2; exit 1;; esac
    iptables -A SOLO_METADATA -m owner --uid-owner "$nscd_uid" -j RETURN
  fi
fi
iptables -A SOLO_METADATA -j REJECT
iptables -C OUTPUT -d 169.254.169.254/32 -j SOLO_METADATA 2>/dev/null || iptables -I OUTPUT 1 -d 169.254.169.254/32 -j SOLO_METADATA
iptables -C FORWARD -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I FORWARD 1 -d 169.254.169.254/32 -j REJECT
# Block container metadata before Docker/Kubernetes forwarding ACCEPT rules.
iptables -t raw -C PREROUTING -d 169.254.169.254/32 -j DROP 2>/dev/null || iptables -t raw -I PREROUTING 1 -d 169.254.169.254/32 -j DROP
