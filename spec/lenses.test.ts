import { expect, test, describe } from "bun:test"
import { Z } from "./setup.ts"
    
const sampleData =
  { name: 'John Doe'
  , age: 30
  , address:
    { street: '123 Main St'
    , city: 'New York'
    , country: 'USA'
    }
  , hobbies: ['reading', 'swimming', 'hiking']
  }  
    
describe("lense", () => {

  describe("get", () => {
    test('getting a simple property', () => {
      expect(Z.get('name', sampleData)).toBe('John Doe')
    })
    test('getting a nested property', () => {
      expect(Z.get(['address', 'city'], sampleData)).toBe('New York')
    })
  })
    
  describe("set", () => {
    test('setting a simple property', () => {
      expect(Z.set('age', 31, sampleData)).toEqual({
        ...sampleData,
        age: 31
      })
    })
    test('setting a nested property', () => {
      expect(Z.set(['address', 'country'], 'Canada', sampleData)).toEqual({
        ...sampleData,
        address: {
          ...sampleData.address,
          country: 'Canada'
        }
      })
    })
  })
    
  describe("modify", () => {
    test('modifying a simple property', () => {
      expect(Z.modify('age', age => age + 1, sampleData)).toEqual({
        ...sampleData,
        age: 31
      })
    })
    test('modifying a nested property', () => {
      expect(Z.modify(['address', 'street'], street => street.toUpperCase(), sampleData)).toEqual({
        ...sampleData,
        address: {
          ...sampleData.address,
          street: '123 MAIN ST'
        }
      })
    })
  })
    
  describe("remove", () => {
    test('removing a simple property', () => {
      expect(Z.remove('age', sampleData)).toEqual({
        name: 'John Doe',
        address: {
          street: '123 Main St',
          city: 'New York',
          country: 'USA'
        },
        hobbies: ['reading', 'swimming', 'hiking']
      })
    })
    test('removing a nested property', () => {
      expect(Z.remove(['address', 'country'], sampleData)).toEqual({
        name: 'John Doe',
        age: 30,
        address: {
          street: '123 Main St',
          city: 'New York'
        },
        hobbies: ['reading', 'swimming', 'hiking']
      })
    })
  })
    
  describe("collect", () => {
    test('collecting all values of a property', () => {
      const data = [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 },
        { name: 'Jim', age: 35 }
      ]
      expect(Z.collect([Z.elems,'age'], data)).toEqual([30, 25, 35])
    })
  })

})
