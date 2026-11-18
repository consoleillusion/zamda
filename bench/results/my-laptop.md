# Reference benchmark: my-laptop

Data: RIPE RIS. Runtime: Bun 1.4.2, linux x64, Intel(R) Core(TM) i5-14500 (20 threads, 31 GB). Run on 2026-11-18.
Medians in ms over several runs after two warm-ups. Every answer was checked against the other engine first.

## 1,000,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 19 | 180 | 9.5x |
| Q2 routes per prefix length | 2.6 | 29 | 11.3x |
| Q3 routes and distinct networks per region * | 13 | 92 | 7.1x |
| Q4 top 20 networks (group, sort, limit) * | 10 | 94 | 9.2x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 19 | 97 | 5.0x |
| Q6 name search ("cloud", case-insensitive) | 4.0 | 109 | 27.3x |
| Q7 full sort of every route (prefix length, address) * | 87 | 31 | 0.4x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 68 | 25 |
| from columns | 42 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 129 ms in zamda, plus 68 ms to load row objects, 197 ms in all.

## 100,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 4.8 | 26 | 5.4x |
| Q2 routes per prefix length | 0.3 | 3.9 | 13.5x |
| Q3 routes and distinct networks per region * | 2.0 | 11 | 5.4x |
| Q4 top 20 networks (group, sort, limit) * | 1.9 | 18 | 9.5x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 2.4 | 11 | 4.4x |
| Q6 name search ("cloud", case-insensitive) | 0.4 | 14 | 33.6x |
| Q7 full sort of every route (prefix length, address) * | 5.9 | 3.1 | 0.5x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 7.2 | 2.8 |
| from columns | 5.3 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 15 ms in zamda, plus 7.2 ms to load row objects, 22 ms in all.

## 10,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 0.8 | 3.0 | 3.9x |
| Q2 routes per prefix length | 0.1 | 0.4 | 8.4x |
| Q3 routes and distinct networks per region * | 0.2 | 1.3 | 5.6x |
| Q4 top 20 networks (group, sort, limit) * | 0.4 | 3.1 | 7.3x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 0.3 | 1.4 | 4.3x |
| Q6 name search ("cloud", case-insensitive) | 0.1 | 1.6 | 25.3x |
| Q7 full sort of every route (prefix length, address) * | 0.6 | 0.3 | 0.6x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 0.8 | 0.2 |
| from columns | 0.7 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 2.0 ms in zamda, plus 0.8 ms to load row objects, 2.8 ms in all.

