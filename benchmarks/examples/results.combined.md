
 # Benchmark Results main
|Benchmark | Units | Round 1 |Round 2 |Round 3 |Round 4 |Round 5 |Round 6 |Round 7 |Round 8 |Round 9 |Round 10
|----------|-------|---|---|---|---|---|---|---|---|---|---
| Sender QoS0 | msg/s| 105136 |86833 |107770 |87467 |97981 |90655 |86321 |105303 |96867 |103146
| Receiver QoS0 | msg/s| 93660 |99659 |93660 |94263 |91496 |98468 |91410 |100207 |102155 |94829
| Sender QoS1 | msg/s| 56585 |53429 |55494 |53735 |59774 |53481 |58312 |56498 |57714 |52888
| Receiver QoS1 | msg/s| 56597 |53413 |55495 |53753 |59763 |53488 |58301 |56500 |57716 |52895



 # Benchmark Results migrate-persistence-to-async
|Benchmark | Units | Round 1 |Round 2 |Round 3 |Round 4 |Round 5 |Round 6 |Round 7 |Round 8 |Round 9 |Round 10
|----------|-------|---|---|---|---|---|---|---|---|---|---
| Sender QoS0 | msg/s| 98534 |99957 |88582 |101414 |86856 |99934 |93408 |89890 |109732 |82295
| Receiver QoS0 | msg/s| 102454 |97864 |96960 |88700 |101739 |91781 |92820 |95840 |96099 |99800
| Sender QoS1 | msg/s| 58938 |58151 |57966 |58268 |56838 |59598 |60402 |60489 |60016 |61523
| Receiver QoS1 | msg/s| 61448 |58928 |58157 |57969 |58261 |56845 |59595 |60403 |60487 |60020



 # Combined Results
| Label | Benchmark | Average | Units | Percentage
|-------|-----------|---------|-------|-----------
| main | Sender QoS0 | 96748 | msg/s | 100.00%
| migrate-persistence-to-async | Sender QoS0 | 95060 | msg/s | 98.26%
| main | Receiver QoS0 | 95981 | msg/s | 100.00%
| migrate-persistence-to-async | Receiver QoS0 | 96406 | msg/s | 100.44%
| main | Sender QoS1 | 55791 | msg/s | 100.00%
| migrate-persistence-to-async | Sender QoS1 | 59219 | msg/s | 106.14%
| main | Receiver QoS1 | 55792 | msg/s | 100.00%
| migrate-persistence-to-async | Receiver QoS1 | 59211 | msg/s | 106.13%
