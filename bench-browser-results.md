Q1: zamda 20.9 ms, no slicing 20.5 ms, Arquero 126.6 ms
Q2: zamda 2.4 ms, no slicing 2.4 ms, Arquero 11.1 ms
Q3: zamda 15.4 ms, no slicing 15.5 ms, Arquero 70.2 ms
Q4: zamda 12.3 ms, no slicing 12.6 ms, Arquero 58.4 ms
Q5: zamda 24.7 ms, no slicing 24.8 ms, Arquero 65.6 ms
Q6: zamda 6.2 ms, no slicing 6.3 ms, Arquero 57.0 ms
Q7: zamda 27.3 ms, no slicing 27.2 ms, Arquero 128.4 ms
interaction (nothing selected): together 96 ms, together no slicing 96 ms, one by one 94 ms
interaction (prefix /22-/24, region ARIN, name "cloud"): together 103 ms, together no slicing 102 ms, one by one 102 ms

## Chrome/156.0.0.0: 1,000,000 rows (medians, ms)

| Query | zamda | zamda, no slicing | Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 21 | 21 | 127 |
| Q2 routes per prefix length | 2.4 | 2.4 | 11 |
| Q3 routes and distinct networks per region | 15 | 16 | 70 |
| Q4 top 20 networks (group, sort, limit) | 12 | 13 | 58 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 25 | 25 | 66 |
| Q6 name search ("cloud", case-insensitive) | 6.2 | 6.3 | 57 |
| Q7 full sort of every route (prefix length, address) | 27 | 27 | 128 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing |
| --- | ---: | ---: | ---: |
| nothing selected | 96 | 96 | 94 |
| prefix /22-/24, region ARIN, name "cloud" | 103 | 102 | 102 |

---

Q1: zamda 23.0 ms, no slicing 23.0 ms, Arquero 182.0 ms
Q2: zamda 2.0 ms, no slicing 2.0 ms, Arquero 13.0 ms
Q3: zamda 17.0 ms, no slicing 16.0 ms, Arquero 81.0 ms
Q4: zamda 13.0 ms, no slicing 13.0 ms, Arquero 82.0 ms
Q5: zamda 20.0 ms, no slicing 21.0 ms, Arquero 97.0 ms
Q6: zamda 3.0 ms, no slicing 3.0 ms, Arquero 48.0 ms
Q7: zamda 37.0 ms, no slicing 38.0 ms, Arquero 45.0 ms
interaction (nothing selected): together 67 ms, together no slicing 66 ms, one by one 65 ms
interaction (prefix /22-/24, region ARIN, name "cloud"): together 92 ms, together no slicing 93 ms, one by one 94 ms

## Firefox/158.0: 1,000,000 rows (medians, ms)


| Query | zamda | zamda, no slicing | Arquero |
| --- | ---: | ---: | ---: |
| Q1 routes per network (group by origin and name) | 23 | 23 | 182 |
| Q2 routes per prefix length | 2.0 | 2.0 | 13 |
| Q3 routes and distinct networks per region | 17 | 16 | 81 |
| Q4 top 20 networks (group, sort, limit) | 13 | 13 | 82 |
| Q5 filtered region chart (prefix /22-/24, path 2-6) | 20 | 21 | 97 |
| Q6 name search ("cloud", case-insensitive) | 3.0 | 3.0 | 48 |
| Q7 full sort of every route (prefix length, address) | 37 | 38 | 45 |

| Dashboard interaction | four charts together | together, no slicing | one by one, no slicing |
| --- | ---: | ---: | ---: |
| nothing selected | 67 | 66 | 65 |
| prefix /22-/24, region ARIN, name "cloud" | 92 | 93 | 94 |
