#!/usr/bin/env python3
"""Render coordinated timeout values; does not contact any host."""
import argparse,json,math
def profile(target):
    if not 15 <= target <= 300: raise ValueError('Supported target: 15..300 seconds')
    scale=target/15
    seconds=lambda v: math.ceil(v*scale)
    partition=seconds(2); wal=seconds(2)
    return {
      'target_seconds':target,
      'monitor':{
        'health_check_period':seconds(1)*1000,
        'health_check_timeout':seconds(1)*1000,
        'health_check_max_retries':1,
        'health_check_retry_delay':math.ceil(500*scale),
        'node_considered_unhealthy_timeout':seconds(3)*1000,
        # Allow the old primary to lose WAL contact, self-demote and drain.
        'primary_demote_timeout':(partition+wal+seconds(2))*1000},
      'keeper':{'network_partition_timeout':partition,'prepare_promotion_walreceiver':seconds(1)},
      'postgres':{'wal_sender_timeout':wal*1000,'wal_receiver_timeout':wal*1000},
      'haproxy':{'interval_seconds':seconds(1),'check_timeout_seconds':seconds(1),'fall':2,'rise':1},
      'nlb':{'interval_seconds':seconds(2),'timeout_seconds':seconds(1),'unhealthy_threshold':2,'healthy_threshold':2}}

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--target-seconds',type=int,default=15)
    args=parser.parse_args()
    print(json.dumps(profile(args.target_seconds)))
