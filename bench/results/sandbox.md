# Reference benchmark: sandbox

Data: synthetic routes (scripts/fake-routes.ts). Runtime: Bun 1.4.4, linux x64, Intel(R) Xeon(R) Processor @ 2.10GHz (2 threads, 8 GB). Run on 2026-11-18.
Medians in ms over several runs after two warm-ups. Every answer was checked against the other engine first.

## 1,000,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 43 | 680 | 15.8x |
| Q2 routes per prefix length | 4.5 | 62 | 13.7x |
| Q3 routes and distinct networks per region * | 33 | 295 | 8.9x |
| Q4 top 20 networks (group, sort, limit) * | 29 | 561 | 19.2x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 43 | 223 | 5.2x |
| Q6 name search ("cloud", case-insensitive) | 11 | 118 | 10.7x |
| Q7 full sort of every route (prefix length, address) * | 149 | 841 | 5.6x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 177 | 82 |
| from columns | 153 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 255 ms in zamda, plus 177 ms to load row objects, 432 ms in all.

## 100,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 12 | 73 | 6.3x |
| Q2 routes per prefix length | 0.8 | 7.3 | 9.1x |
| Q3 routes and distinct networks per region * | 12 | 36 | 2.9x |
| Q4 top 20 networks (group, sort, limit) * | 10 | 66 | 6.4x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 4.9 | 20 | 4.2x |
| Q6 name search ("cloud", case-insensitive) | 1.3 | 15 | 11.9x |
| Q7 full sort of every route (prefix length, address) * | 11 | 57 | 5.4x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 22 | 5.8 |
| from columns | 17 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 45 ms in zamda, plus 22 ms to load row objects, 66 ms in all.

## 10,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 2.0 | 6.3 | 3.2x |
| Q2 routes per prefix length | 0.2 | 0.8 | 3.9x |
| Q3 routes and distinct networks per region * | 0.5 | 3.1 | 6.3x |
| Q4 top 20 networks (group, sort, limit) * | 1.2 | 8.7 | 7.0x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 0.4 | 2.5 | 6.1x |
| Q6 name search ("cloud", case-insensitive) | 0.1 | 1.5 | 13.9x |
| Q7 full sort of every route (prefix length, address) * | 0.7 | 4.1 | 5.7x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 2.4 | 0.5 |
| from columns | 1.8 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 4.4 ms in zamda, plus 2.4 ms to load row objects, 6.9 ms in all.

