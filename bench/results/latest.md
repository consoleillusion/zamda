# Reference benchmark: latest

Data: RIPE RIS. Runtime: Bun 1.4.2, linux x64, Intel(R) Core(TM) i5-14500 (20 threads, 31 GB). Run on 2026-11-18.
Medians in ms over several runs after two warm-ups. Every answer was checked against the other engine first.

## 1,000,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 19 | 181 | 9.3x |
| Q2 routes per prefix length | 2.6 | 30 | 11.7x |
| Q3 routes and distinct networks per region * | 13 | 89 | 7.0x |
| Q4 top 20 networks (group, sort, limit) * | 11 | 96 | 9.1x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 18 | 95 | 5.3x |
| Q6 name search ("cloud", case-insensitive) | 4.1 | 112 | 27.6x |
| Q7 full sort of every route (prefix length, address) * | 90 | 31 | 0.3x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 68 | 24 |
| from columns | 43 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 132 ms in zamda, plus 68 ms to load row objects, 201 ms in all.

## 100,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 4.1 | 26 | 6.2x |
| Q2 routes per prefix length | 0.3 | 3.9 | 13.4x |
| Q3 routes and distinct networks per region * | 2.2 | 10 | 4.7x |
| Q4 top 20 networks (group, sort, limit) * | 2.0 | 17 | 8.5x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 2.4 | 11 | 4.3x |
| Q6 name search ("cloud", case-insensitive) | 0.4 | 13 | 28.8x |
| Q7 full sort of every route (prefix length, address) * | 5.9 | 3.1 | 0.5x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 7.3 | 2.9 |
| from columns | 6.0 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 14 ms in zamda, plus 7.3 ms to load row objects, 22 ms in all.

## 10,000 rows

| Query | zamda | Arquero | zamda vs Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) * | 0.7 | 3.1 | 4.5x |
| Q2 routes per prefix length | 0.1 | 0.4 | 6.2x |
| Q3 routes and distinct networks per region * | 0.3 | 1.3 | 5.0x |
| Q4 top 20 networks (group, sort, limit) * | 0.4 | 2.8 | 7.8x |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 0.3 | 1.4 | 4.5x |
| Q6 name search ("cloud", case-insensitive) | 0.1 | 1.8 | 36.6x |
| Q7 full sort of every route (prefix length, address) * | 0.6 | 0.4 | 0.6x |

\* the spike gate's "grouped aggregate and sort" set.

| Building the table | zamda | Arquero |
| --- | ---: | ---: |
| from row objects | 0.9 | 0.3 |
| from columns | 0.7 | 0.0 |

**Number the spike must beat by 3x at this size:** the gate queries take 1.9 ms in zamda, plus 0.9 ms to load row objects, 2.8 ms in all.

