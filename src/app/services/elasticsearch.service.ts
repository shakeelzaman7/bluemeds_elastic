import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError, tap, switchMap } from 'rxjs/operators';

// Type definitions for better type safety
export interface ProductDetails {
  id: string;
  product: {
    productCode: string;
    name: string;
    presentation: string;
    details: {
      ingredient_1: string;
      laboratory: string;
    }
  };
  priceText: string;
  portalPriceText: string;
  discountText: string;
}

export interface SearchResult {
  data: ProductDetails[];
  total: number;
}

export interface Suggestion {
  id: string;
  name: string;
  code: string;
  ingredient: string;
  laboratory: string;
}

interface ElasticsearchHit {
  _id: string;
  _source: any;
  _score: number;
}

interface ElasticsearchResponse {
  hits: {
    hits: ElasticsearchHit[];
    total: {
      value: number;
      relation: string;
    };
  };
  aggregations?: any;
}

@Injectable({
  providedIn: 'root'
})
export class ElasticsearchService {
  
  // Use environment variable for API URL
  private proxyUrl =  'http://localhost:3000/api/elastic-search';
 
  constructor(private http: HttpClient) { }
 
  searchProducts(
    searchTerm: string, 
    size: number = 10,
    filters: any = {},
    sortOptions: any = {}
  ): Observable<SearchResult> {
    
    if (!searchTerm || searchTerm.trim() === '') {
      return of({ data: [], total: 0 });
    }

    searchTerm = searchTerm.trim().replace(/\s+/g, ' ');
    console.log('Cleaned search term:', searchTerm);

    const query: any = {
      query: {
        bool: {
          must: [
            {
              bool: {
                should: [
                  // Search in all_text field (includes name, ingredient, laboratory, therapeutic area)
                  { 
                    match: { 
                      "all_text": { 
                        query: searchTerm,
                        boost: 1,
                        operator: "and" 
                      } 
                    } 
                  },
                  
                  // Exact phrase match in name (highest boost)
                  {
                    match_phrase: {
                      "name": {
                        query: searchTerm,
                        boost: 3
                      }
                    }
                  },
                  
                  // Terms match in name (high boost) 
                  { 
                    match: { 
                      "name": { 
                        query: searchTerm,
                        boost: 2,
                        operator: "and"
                      } 
                    } 
                  },
                  
                  // Cross-field search across multiple fields
                  {
                    multi_match: {
                      query: searchTerm,
                      fields: ["name^2", "all_text^1.5", "ingredient_1^1.8"],
                      type: "cross_fields",
                      operator: "and"
                    }
                  }
                ],
                minimum_should_match: 1
              }
            }
          ],
          // Filter array for post-query filtering
          filter: []
        }
      },
      size: size
    };

    // Apply filters
    if (filters) {
      // Laboratory filter
      if (filters.laboratory) {
        query.query.bool.filter.push({
          term: { "laboratory.keyword": filters.laboratory }
        });
      }

      // Therapeutic area filter
      if (filters.therapeutic_area) {
        query.query.bool.filter.push({
          term: { "therapeutic_area.keyword": filters.therapeutic_area }
        });
      }

      // Recipe requirement filter
      if (filters.requires_recipe !== undefined) {
        query.query.bool.filter.push({
          term: { "requires_recipe": filters.requires_recipe }
        });
      }
    }

    // Apply sorting
    if (Object.keys(sortOptions).length > 0) {
      query.sort = [];
      
      // Add all specified sort fields
      Object.entries(sortOptions).forEach(([field, order]) => {
        const sortObj = {};
        sortObj[field] = { order };
        query.sort.push(sortObj);
      });
      
      // Always add score as the final sort criterion
      query.sort.push({ "_score": { "order": "desc" } });
    }
   
    console.log('Elasticsearch query:', JSON.stringify(query));
   
    return this.http.post<ElasticsearchResponse>(this.proxyUrl, query)
      .pipe(
        tap((response: ElasticsearchResponse) => {
          console.log('Elasticsearch response received');
          console.log('Raw hits count:', response?.hits?.hits?.length || 0);
        }),
        map((response: ElasticsearchResponse) => {
          return this.transformToPublications(response);
        }),
        tap(transformedResults => {
          console.log('Transformed data items:', transformedResults?.data?.length || 0);
        }),
        catchError(error => {
          console.error('Elasticsearch error:', error);
          return of({ data: [], total: 0 });
        })
      );
  }
 
  /**
   * Get type-ahead suggestions for the search box
   * @param prefix The search prefix to get suggestions for
   * @param size Number of suggestions to return
   */
  getSuggestions(prefix: string, size: number = 5): Observable<{suggestions: Suggestion[]}> {
    if (!prefix || prefix.trim() === '') {
      return of({ suggestions: [] });
    }

    // Clean prefix
    prefix = prefix.trim().replace(/\s+/g, ' ');

    // Use match_phrase_prefix for prefix matching
    const query = {
      query: {
        match_phrase_prefix: {
          "name": {
            query: prefix
          }
        }
      },
      _source: ["id", "name", "product_code", "ingredient_1", "laboratory"],
      size: size
    };

    return this.http.post<ElasticsearchResponse>(this.proxyUrl, query)
      .pipe(
        map((response: ElasticsearchResponse) => {
          const hits = response?.hits?.hits || [];
          return {
            suggestions: hits.map(hit => ({
              id: hit._source.id,
              name: hit._source.name,
              code: hit._source.product_code,
              ingredient: hit._source.ingredient_1,
              laboratory: hit._source.laboratory
            }))
          };
        }),
        catchError(error => {
          console.error('Suggestion error:', error);
          return of({ suggestions: [] });
        })
      );
  }
  
  /**
   * Alias for getSuggestions to match the method name used in the component
   */
  getAutocompleteSuggestions(prefix: string, size: number = 5): Observable<{suggestions: Suggestion[]}> {
    return this.getSuggestions(prefix, size);
  }
  
  /**
   * Get analytics data for product filters (labs, therapeutic areas)
   */
  getProductAnalytics(): Observable<{laboratories: any[], therapeuticAreas: any[]}> {
    // Aggregation query to get labs and therapeutic areas
    const query = {
      size: 0,
      aggs: {
        laboratories: {
          terms: {
            field: "laboratory.keyword",
            size: 100
          }
        },
        therapeutic_areas: {
          terms: {
            field: "therapeutic_area.keyword",
            size: 50,
            missing: "No definido"
          }
        }
      }
    };
    
    return this.http.post<ElasticsearchResponse>(this.proxyUrl, query)
      .pipe(
        map((response: ElasticsearchResponse) => {
          return {
            laboratories: response?.aggregations?.laboratories?.buckets || [],
            therapeuticAreas: response?.aggregations?.therapeutic_areas?.buckets || []
          };
        }),
        catchError(error => {
          console.error('Analytics error:', error);
          return of({ 
            laboratories: [],
            therapeuticAreas: []
          });
        })
      );
  }
  
  /**
   * Get related products based on product ID
   */
  getRelatedProducts(productId: string, size: number = 5): Observable<SearchResult> {
    // First query to get the product details
    const productQuery = {
      query: {
        term: {
          "id": productId
        }
      },
      _source: ["name", "laboratory", "ingredient_1", "therapeutic_area"]
    };
    
    return this.http.post<ElasticsearchResponse>(this.proxyUrl, productQuery)
      .pipe(
        switchMap((productResponse: ElasticsearchResponse) => {
          const product = productResponse?.hits?.hits[0]?._source;
          
          if (!product) {
            return of({ data: [], total: 0 });
          }
          
          // Build query to find similar products
          const relatedQuery = {
            query: {
              bool: {
                should: [
                  // Same lab (moderate boost)
                  product.laboratory ? {
                    term: {
                      "laboratory.keyword": {
                        value: product.laboratory,
                        boost: 1.5
                      }
                    }
                  } : null,
                  
                  // Same ingredient (highest boost)
                  product.ingredient_1 ? {
                    term: {
                      "ingredient_1.keyword": {
                        value: product.ingredient_1,
                        boost: 3
                      }
                    }
                  } : null,
                  
                  // Same therapeutic area (high boost)
                  product.therapeutic_area ? {
                    term: {
                      "therapeutic_area.keyword": {
                        value: product.therapeutic_area,
                        boost: 2
                      }
                    }
                  } : null,
                  
                  // Similar name (low boost)
                  {
                    match: {
                      "name": {
                        query: product.name,
                        boost: 1
                      }
                    }
                  }
                ],
                must_not: [
                  // Exclude the current product
                  {
                    term: {
                      "id": productId
                    }
                  }
                ],
                minimum_should_match: 1
              }
            },
            size: size
          };
          
          // Filter out null values from should array
          relatedQuery.query.bool.should = relatedQuery.query.bool.should.filter(Boolean);
          
          // If there are no should clauses, return empty result
          if (relatedQuery.query.bool.should.length === 0) {
            return of({ data: [], total: 0 });
          }
          
          // Execute the related products query
          return this.http.post<ElasticsearchResponse>(this.proxyUrl, relatedQuery).pipe(
            map(response => this.transformToPublications(response)),
            catchError(error => {
              console.error('Related products error:', error);
              return of({ data: [], total: 0 });
            })
          );
        }),
        catchError(error => {
          console.error('Error getting product for related search:', error);
          return of({ data: [], total: 0 });
        })
      );
  }
 
  /**
   * Transform Elasticsearch results to the application's product format
   */
  private transformToPublications(elasticResponse: ElasticsearchResponse): SearchResult {
    try {
      const hits = elasticResponse?.hits?.hits || [];
      console.log(`Processing ${hits.length} hits from Elasticsearch`);
     
      if (hits.length === 0) {
        console.log('No hits found in Elasticsearch response');
        return {
          data: [],
          total: 0
        };
      }
     
      const data = hits.map((hit, index) => {
        const source = hit._source;
       
        const packaging = source.packaging || '';
        const packagingUnit = source.packaging_unit || '';
        const presentation = packaging + (packagingUnit ? ' ' + packagingUnit : '');
       
        // TODO: Replace random pricing with actual price data when available
        const transformed = {
          id: source.id?.toString() || '',
          product: {
            productCode: source.product_code || '',
            name: source.name || '',
            presentation: presentation,
            details: {
              ingredient_1: source.ingredient_1 || 'No información disponible',
              laboratory: source.laboratory || 'No información disponible'
            }
          },
          priceText: 'Q ' + (Math.random() * 100 + 50).toFixed(2),  // Placeholder
          portalPriceText: 'Q ' + (Math.random() * 80 + 40).toFixed(2),  // Placeholder
          discountText: ((Math.random() * 20) + 10).toFixed(2)  // Placeholder
        };
        
        // Log just a few items for debugging
        if (index < 2) {
          console.log(`Transformed item ${index}:`, JSON.stringify({
            id: transformed.id,
            name: transformed.product.name,
            ingredient: transformed.product.details.ingredient_1
          }));
        }
        
        return transformed;
      });
     
      const result = {
        data: data,
        total: elasticResponse?.hits?.total?.value || 0
      };
      
      console.log(`Transformation complete: ${result.data.length} items`);
      return result;
      
    } catch (error) {
      console.error('Error transforming Elasticsearch response:', error);
      return {
        data: [],
        total: 0
      };
    }
  }
}