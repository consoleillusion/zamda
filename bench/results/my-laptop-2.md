# Reference benchmark: my-laptop-2

Data: RIPE RIS. Runtime: Bun 1.4.2, linux x64, Intel(R) Core(TM) i5-14500 (20 threads, 31 GB). Run on 2026-11-18.
Medians in ms over several runs after two warm-ups. Every answer was checked against the other engine first.

## 1,000,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 18 | 183 | 10.3x |
| Q2 routes per prefix length | 2.4 | 29 | 11.9x |
| Q3 routes and distinct networks per region * | 12 | 89 | 7.2x |
| Q4 top 20 networks (group, sort, limit) * | 10 | 94 | 9.2x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 19 | 92 | 4.8x |
| Q6 name search ("cloud", case-insensitive) | 4.0 | 108 | 27.1x |
| Q7 full sort of every route (prefix length, address) * | 72 | 31 | 0.4x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 66 | 25 |
| from columns | 45 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 112 ms in zamda, plus 66 ms to load row objects, 178 ms in all.

## 100,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 5.0 | 26 | 5.2x |
| Q2 routes per prefix length | 0.3 | 3.7 | 13.0x |
| Q3 routes and distinct networks per region * | 2.0 | 11 | 5.3x |
| Q4 top 20 networks (group, sort, limit) * | 1.9 | 17 | 9.2x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 2.3 | 11 | 4.6x |
| Q6 name search ("cloud", case-insensitive) | 0.4 | 14 | 33.3x |
| Q7 full sort of every route (prefix length, address) * | 6.2 | 3.0 | 0.5x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 6.9 | 2.9 |
| from columns | 5.8 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 15 ms in zamda, plus 6.9 ms to load row objects, 22 ms in all.

## 10,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 0.8 | 3.0 | 3.8x |
| Q2 routes per prefix length | 0.1 | 0.4 | 6.5x |
| Q3 routes and distinct networks per region * | 0.2 | 1.4 | 6.2x |
| Q4 top 20 networks (group, sort, limit) * | 0.4 | 3.0 | 7.4x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 0.3 | 1.4 | 4.2x |
| Q6 name search ("cloud", case-insensitive) | 0.1 | 1.6 | 28.4x |
| Q7 full sort of every route (prefix length, address) * | 0.7 | 0.4 | 0.6x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 0.9 | 0.2 |
| from columns | 0.7 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 2.1 ms in zamda, plus 0.9 ms to load row objects, 2.9 ms in all.

