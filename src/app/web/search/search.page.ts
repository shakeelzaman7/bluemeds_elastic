import {Component, Input, Output, OnInit, ElementRef, ViewChild, EventEmitter, ChangeDetectorRef, AfterViewInit, OnDestroy, NgZone} from '@angular/core';
import {MatDialog} from '@angular/material/dialog';
import {TableColumn} from 'src/app/@vex/interfaces/table-column.interface';
import {Publication} from 'src/app/models/publication';
import icSearch from '@iconify/icons-ic/twotone-search';
import icFilter from '@iconify/icons-ic/twotone-filter-list';
import icSort from '@iconify/icons-ic/twotone-sort';
import {FormControl, FormGroup, FormBuilder} from '@angular/forms';
import {debounceTime, tap, distinctUntilChanged, takeUntil, finalize} from 'rxjs/operators';
import {ResourceTableComponent} from 'src/app/core/components/resource-table/resource-table.component';
import {ModalController} from '@ionic/angular';
import {PublicationModalComponent} from '../components/publication-modal/publication-modal.component';
import {AuthService} from 'src/app/core/auth/auth.service';
import {ListService} from '../services/list/list.service';
import {LayoutService} from 'src/app/@vex/services/layout.service';
import { Router, ActivatedRoute } from '@angular/router';
import {BudgetService} from "../services/budget/budget.service";
import {ElasticsearchService} from "../../services/elasticsearch.service";
import { BehaviorSubject, Subject, ReplaySubject } from 'rxjs';

@Component({
  selector: 'app-search',
  templateUrl: './search.page.html',
  styleUrls: ['./search.page.scss'],
})
export class SearchPage implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('searchInput') searchInputElement: ElementRef;
  @ViewChild('tooltipMessage', { static: true }) tooltipMessage: any;
  @ViewChild(ResourceTableComponent) table: ResourceTableComponent<Publication>;

  // Form controls
  public searchForm: FormGroup;
  public searchCtrl = new FormControl();
  public suggestionsList: any[] = [];
  public showSuggestions = false;
  
  // Icons
  resourceType = Publication;
  icSearch = icSearch;
  icFilter = icFilter;
  icSort = icSort;
  
  // Search state
  searchParams: any = {
    key: null,
    filters: {},
    sort: {}
  };
  items: any[] = [];
  searchResults: any[] = [];
  isSearching = false;
  totalSearchResults = 0;
  searchError: string = '';
  showFilters: boolean = false;
  
  // Filter options
  laboratories: string[] = [];
  therapeuticAreas: string[] = [];
  
  // Sort options
  sortOptions = [
    { label: 'Relevancia', value: 'score' },
    { label: 'Precio (menor a mayor)', value: 'price_asc' },
    { label: 'Precio (mayor a menor)', value: 'price_desc' },
    { label: 'Nombre A-Z', value: 'name_asc' },
    { label: 'Nombre Z-A', value: 'name_desc' },
    { label: 'Laboratório', value: 'laboratory' }
  ];
  
  // Results display
  results: boolean = false;
  searchTimer: any = null;

  // Cleanup
  private destroy$ = new Subject<void>();

  directionList = [
    {text: 'Inicio', route: '/web/home'},
    {text: 'Buscar medicamentos', route: '/web/search/'}
  ];

  @Input()
  columns: TableColumn<Publication>[] = [
    {
      label: '', property: 'image', cssClasses: ['img-search align-top pt-5 sm:align-middle sm:py-1'], type: 'image', visible: true, transform: (p) => {
        return 'https://blue-production-s3-public-media.s3.amazonaws.com/productos/' + p.product.productCode + '_1.jpg';
      }
    },
    {label: 'Nombre del producto', property: 'product.name', cssClasses: ['pb-2'], type: 'text', visible: true, sorteable: true},
    {label: 'Principio activo', property: 'product.details.ingredient_1', cssClasses: ['pb-2'], type: 'text', visible: true},
    {label: 'Presentación', property: 'product.presentation', cssClasses: ['pb-2'], type: 'text', visible: true},
    {
      label: 'Precio normal', property: 'priceText', cssClasses: ['pb-2'], type: 'html', visible: true, transform: (p) => {
        return `<del>${p.priceText}</del>`;
      }
    },
    {
      label: 'Precio Bluemeds',
      property: 'portalPriceText',
      cssClasses: ['bluemeds-offer-price-text', 'pb-2'],
      type: 'text',
      visible: true
    },
    {
      label: 'Ahorro', property: 'discountText', cssClasses: ['pb-2'], type: 'html', visible: true, transform: (p) => {
        return `<div class="relative mt-2 sm:mt-0"><span class="bg-[#e45900] text-white pl-1 pr-2 rounded-l-[5px] py-1 text-bottom font-bold flag-search">${p.discountText.includes('Q') ? p.discountText : 'Q ' + p.discountText}</span></div>`;
      }
    },
    {label: '', property: 'button', cssClasses: ['pb-2'], type: 'button', visible: true, sorteable: false, buttonLabel: 'Agregar'}
  ];

  @Output() modalClosed = new EventEmitter<void>();

  constructor(
    private matDialog: MatDialog,
    private modalCtrl: ModalController,
    private authService: AuthService,
    private listService: ListService,
    public layoutService: LayoutService,
    private router: Router,
    private route: ActivatedRoute,
    private budgetService: BudgetService,
    private elasticsearchService: ElasticsearchService,
    private cdr: ChangeDetectorRef,
    private formBuilder: FormBuilder,
    private ngZone: NgZone
  ) {
    this.initSearchForm();
  }

  initSearchForm() {
    this.searchForm = this.formBuilder.group({
      searchTerm: [''],
      laboratory: [''],
      therapeuticArea: [''],
      sortBy: ['score']
    });
  }

  async openPublicationModal(publication: Publication) {
    const modal = await this.modalCtrl.create({
      component: PublicationModalComponent,
      componentProps: {
        publication
      },
      cssClass: this.layoutService.isMobile() ? '' : 'publication-modal'
    });

    modal.present();

    const {data, role} = await modal.onWillDismiss();

    if (role === 'add') {
      // Implementation omitted
    }

    if (this.table) {
      this.table.scrollToRow(publication.id);
      await this.start();
    }
    
    this.loadRelatedProducts(publication.id?.toString());
  }

  publicationSelected(publication: Publication) {
    this.router.navigate([], { queryParams: { product_name: publication.product.name}, queryParamsHandling: 'merge' });
    this.openPublicationModal(publication);
  }

  ngOnInit(): void {
    this.start();
    this.loadFilterOptions();
    
    // Process URL parameters
    this.route.queryParams
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        if (params['query']) {
          this.searchCtrl.setValue(params['query']);
          this.searchForm.get('searchTerm').setValue(params['query']);
          
          if (params['lab']) {
            this.searchForm.get('laboratory').setValue(params['lab']);
          }
          
          if (params['area']) {
            this.searchForm.get('therapeuticArea').setValue(params['area']);
          }
          
          if (params['sort']) {
            this.searchForm.get('sortBy').setValue(params['sort']);
          }
        }
      });

    // Configure search autocomplete suggestions
    this.searchCtrl.valueChanges
      .pipe(
        takeUntil(this.destroy$),
        debounceTime(300), 
        distinctUntilChanged(),
        tap(value => {
          if (value && value.length >= 2) {
            this.getAutocompleteSuggestions(value);
          } else {
            this.suggestionsList = [];
            this.showSuggestions = false;
          }
        })
      )
      .subscribe(value => this.onSearch(value));
      
    // Configure form filter changes
    this.searchForm.valueChanges
      .pipe(
        takeUntil(this.destroy$),
        debounceTime(300)
      )
      .subscribe(formValues => {
        this.updateSearchParams(formValues);
        
        if (formValues.searchTerm && formValues.searchTerm.length >= 4) {
          this.performElasticSearch(formValues.searchTerm);
        }
      });
  }

  /**
   * Update search parameters from form values
   */
  private updateSearchParams(formValues: any) {
    this.searchParams.key = formValues.searchTerm;
    
    // Update filters
    this.searchParams.filters = {};
    if (formValues.laboratory) {
      this.searchParams.filters.laboratory = formValues.laboratory;
    }
    if (formValues.therapeuticArea) {
      this.searchParams.filters.therapeutic_area = formValues.therapeuticArea;
    }
    
    // Update sort options
    this.searchParams.sort = {};
    switch(formValues.sortBy) {
      case 'price_asc':
        this.searchParams.sort.price = 'asc';
        break;
      case 'price_desc':
        this.searchParams.sort.price = 'desc';
        break;
      case 'name_asc':
        this.searchParams.sort['name.raw'] = 'asc';
        break;
      case 'name_desc':
        this.searchParams.sort['name.raw'] = 'desc';
        break;
      case 'laboratory':
        this.searchParams.sort['laboratory.keyword'] = 'asc';
        break;
    }
  }

  ngAfterViewInit() {
    // Wait for component to be fully initialized before setting up
    setTimeout(() => {
      // Apply any pending search results if we have them
      if (this.searchResults && this.searchResults.length > 0 && this.table) {
        this.ensureTableUpdate(this.searchResults);
      }
      
      // Check for URL params and trigger initial search if needed
      const searchTerm = this.searchForm.get('searchTerm').value;
      if (searchTerm && searchTerm.length >= 4) {
        this.performElasticSearch(searchTerm);
      }
    }, 200);
  }

  ngOnDestroy() {
    // Clean up all subscriptions
    this.destroy$.next();
    this.destroy$.complete();
    
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
  }

  /**
   * Enhanced method to ensure table updates correctly regardless of result set size
   */
  private ensureTableUpdate(results: any[]) {
    // Give time for the component to fully initialize if needed
    setTimeout(() => {
      if (!this.table || !this.table.subject$) {
        console.warn('Table component not properly initialized');
        return;
      }
      
      // Force a new reference (important for change detection)
      const data = [...results];
      
      // Update table's internal properties and state
      this.table.totalElements = data.length;
      this.table.hasDataLoaded = true;
      
      // Apply updates within NgZone to ensure change detection
      this.ngZone.run(() => {
        // Update the table data
        this.table.subject$.next(data);
        
        // Force pagination update if needed
        if (this.table.paginator) {
          this.table.paginator.length = data.length;
          this.table.paginator.firstPage();
        }
        
        // Force change detection
        this.cdr.detectChanges();
        
        console.log(`Table updated with ${data.length} items`);
      });
      
      // Double-check update after a short delay (helps with some edge cases)
      setTimeout(() => {
        if (this.table.totalElements !== data.length) {
          console.warn('Table update inconsistency detected, forcing second update');
          this.ngZone.run(() => {
            this.table.subject$.next([...data]);
            this.cdr.detectChanges();
          });
        }
      }, 100);
    }, 0);
  }

  async start() {
    if (await this.authService.isAuthenticated()) {
      await this.listService.getlist();

      let typeBatche = [];
      if (this.listService.list.data.batches.with_insurance.length > 0) {
        typeBatche = typeBatche.concat(this.listService.list.data.batches.with_insurance);
      }

      if (this.listService.list.data.batches.without_insurance.length > 0) {
        typeBatche = typeBatche.concat(this.listService.list.data.batches.without_insurance);
      }

      if (typeBatche.length > 0) {
        typeBatche.forEach(batch => {
          batch.items.forEach((med: any) => {
            this.items.push(med);
          });
        });
      }
    } else {
      let budget = await this.budgetService.getItemsFromStorage();

      if (budget.length > 0) {
        this.items = budget;
      }
    }
  }

  focusSearchInput() {
    if (this.tooltipMessage) {
      this.tooltipMessage.toggle();
    }
    if (this.searchInputElement && this.searchInputElement.nativeElement) {
      this.searchInputElement.nativeElement.focus();
    }
  }

  onSearch(value: string): void {
    this.searchError = '';
    
    if (!value) {
      this.clearResults();
      return;
    }

    // Update the form with the new search term
    this.searchForm.get('searchTerm').setValue(value, { emitEvent: false });
    this.searchParams.key = value;

    // Debounce the search execution
    if (value.length > 3) {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.performElasticSearch(value);
      }, 300); 
    } else {
      this.clearResults();
    }
  }

  /**
   * Clear search results
   */
  private clearResults() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    
    if (this.table) {
      this.table.totalElements = 0;
      
      if (this.table.subject$) {
        this.table.subject$.next([]);
      }
      
      this.table.hasDataLoaded = true;
    }
    
    this.searchResults = [];
  }

  /**
   * Perform Elasticsearch search with improved error handling
   */
  performElasticSearch(searchTerm: string) {
    // Validate search term
    if (!searchTerm || searchTerm.length < 4) {
      return;
    }
    
    const cleanedTerm = searchTerm.trim().replace(/\s+/g, ' ');
    
    // Set loading state
    this.isSearching = true;
    this.searchResults = [];
    
    if (this.table) {
      this.table.totalElements = 0;
      if (this.table.subject$) {
        this.table.subject$.next([]);
      }
      this.table.hasDataLoaded = false;
    }
    
    // Update URL parameters
    this.updateUrlParams(cleanedTerm);
    
    // Execute search
    this.elasticsearchService.searchProducts(
      cleanedTerm, 
      100, 
      this.searchParams.filters,
      this.searchParams.sort
    )
    .pipe(
      finalize(() => this.isSearching = false)
    )
    .subscribe({
      next: (results) => {
        // Store results
        this.searchResults = results.data || [];
        this.totalSearchResults = results.total || 0;
        
        // Use enhanced table update method
        this.ensureTableUpdate(this.searchResults);
      },
      error: (error) => {
        console.error('Search error:', error);
        this.searchError = 'Error connecting to search service. Please try again.';
        this.searchResults = [];
        
        if (this.table) {
          this.table.totalElements = 0;
          this.table.hasDataLoaded = true;
          
          if (this.table.subject$) {
            this.table.subject$.next([]);
          }
        }
      }
    });
  }

  /**
   * Update URL parameters to reflect current search
   */
  private updateUrlParams(searchTerm: string) {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        query: searchTerm,
        lab: this.searchParams.filters.laboratory || null,
        area: this.searchParams.filters.therapeutic_area || null,
        sort: this.searchForm.get('sortBy').value || 'score'
      },
      queryParamsHandling: 'merge'
    });
  }
  
  /**
   * Load filter options from Elasticsearch
   */
  loadFilterOptions() {
    this.elasticsearchService.getProductAnalytics().subscribe({
      next: (analytics) => {
        this.laboratories = analytics.laboratories.map(lab => lab.key);
        this.therapeuticAreas = analytics.therapeuticAreas.map(area => area.key);
      },
      error: (error) => {
        console.error('Failed to load filter options:', error);
      }
    });
  }
  
  /**
   * Get autocomplete suggestions as user types
   */
  getAutocompleteSuggestions(prefix: string) {
    if (prefix.length < 2) {
      this.suggestionsList = [];
      this.showSuggestions = false;
      return;
    }
    
    this.elasticsearchService.getAutocompleteSuggestions(prefix).subscribe({
      next: (result) => {
        this.suggestionsList = result.suggestions;
        this.showSuggestions = this.suggestionsList.length > 0;
      },
      error: (error) => {
        console.error('Failed to get suggestions:', error);
        this.suggestionsList = [];
        this.showSuggestions = false;
      }
    });
  }
  
  /**
   * Select a suggestion from the autocomplete dropdown
   */
  selectSuggestion(suggestion: any) {
    this.searchCtrl.setValue(suggestion.name);
    this.suggestionsList = [];
    this.showSuggestions = false;
    this.performElasticSearch(suggestion.name);
  }
  
  /**
   * Load related products after viewing a product
   */
  loadRelatedProducts(productId: string | null | undefined) {
    if (!productId) {
      return;
    }
    
    this.elasticsearchService.getRelatedProducts(productId).subscribe({
      next: (results) => {
        // Implementation for displaying related products would go here
      },
      error: (error) => {
        console.error('Failed to load related products:', error);
      }
    });
  }

  /**
   * Reset search and clear all results
   */
  resetSearch() {
    this.searchCtrl.setValue("");
    this.searchForm.reset({
      searchTerm: '',
      laboratory: '',
      therapeuticArea: '',
      sortBy: 'score'
    });
    this.searchParams = {
      key: null,
      filters: {},
      sort: {}
    };
    
    this.clearResults();
    
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {},
      replaceUrl: true
    });
    
    this.suggestionsList = [];
    this.showSuggestions = false;
  }

  toggleFilters() {
    this.showFilters = !this.showFilters;
  }

  showResultsForm() {
    this.results = true;
  }

  openWindowsWhatsApp() {
    window.open('https://api.whatsapp.com/send/?phone=50224272000&text&type=phone_number&app_absent=0', '_blank');
  }

  handleOutsideClick(event: Event) {
    if (this.showSuggestions && 
        this.searchInputElement &&
        !this.searchInputElement.nativeElement.contains(event.target) && 
        !event.target['closest']('.suggestions-container')) {
      this.showSuggestions = false;
    }
  }
  
  trackSuggestions(index: number, item: any) {
    return item?.id || index;
  }
}