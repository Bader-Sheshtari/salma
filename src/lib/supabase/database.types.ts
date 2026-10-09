export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_kind: string
          actor_name: string | null
          actor_role: string | null
          after_value: string | null
          before_value: string | null
          created_at: string
          details: Json | null
          id: number
          target_email: string | null
          target_id: string | null
          target_name: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_kind: string
          actor_name?: string | null
          actor_role?: string | null
          after_value?: string | null
          before_value?: string | null
          created_at?: string
          details?: Json | null
          id?: never
          target_email?: string | null
          target_id?: string | null
          target_name?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_kind?: string
          actor_name?: string | null
          actor_role?: string | null
          after_value?: string | null
          before_value?: string | null
          created_at?: string
          details?: Json | null
          id?: never
          target_email?: string | null
          target_id?: string | null
          target_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_image_usage: {
        Row: {
          actual_image_count: number
          completed_at: string | null
          created_at: string
          failure_reason: string | null
          id: number
          quality: string
          requested_image_count: number
          status: string
          user_id: string
        }
        Insert: {
          actual_image_count?: number
          completed_at?: string | null
          created_at?: string
          failure_reason?: string | null
          id?: never
          quality: string
          requested_image_count: number
          status?: string
          user_id: string
        }
        Update: {
          actual_image_count?: number
          completed_at?: string | null
          created_at?: string
          failure_reason?: string | null
          id?: never
          quality?: string
          requested_image_count?: number
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      app_config: {
        Row: {
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      categories: {
        Row: {
          accent: string
          name_ar: string
          name_en: string | null
          show_in_nav: boolean
          slug: string
          sort_order: number
        }
        Insert: {
          accent?: string
          name_ar: string
          name_en?: string | null
          show_in_nav?: boolean
          slug: string
          sort_order?: number
        }
        Update: {
          accent?: string
          name_ar?: string
          name_en?: string | null
          show_in_nav?: boolean
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      comments: {
        Row: {
          author_name: string
          body: string
          content_id: string
          created_at: string
          id: string
          status: string
        }
        Insert: {
          author_name: string
          body: string
          content_id: string
          created_at?: string
          id?: string
          status?: string
        }
        Update: {
          author_name?: string
          body?: string
          content_id?: string
          created_at?: string
          id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
        ]
      }
      content: {
        Row: {
          ai_summary: string | null
          author_id: string | null
          body: string | null
          body_tsv: unknown
          category_slug: string | null
          cover_credit_name: string | null
          cover_credit_url: string | null
          cover_image_url: string | null
          created_at: string
          created_by: string | null
          dedupe_key: string | null
          deleted_at: string | null
          deleted_by: string | null
          excerpt: string | null
          first_published_at: string | null
          id: string
          is_breaking: boolean
          is_featured: boolean
          last_edited_at: string | null
          last_edited_by: string | null
          last_published_at: string | null
          origin: string
          original_title: string | null
          original_url: string | null
          published_at: string | null
          published_by: string | null
          read_minutes: number | null
          relevance_score: number | null
          reviewed_at: string | null
          reviewed_by: string | null
          search_norm: string | null
          slug: string
          source_image_url: string | null
          source_lang: string | null
          source_name: string | null
          source_url: string | null
          status: string
          title: string
          type: string
          unpublished_at: string | null
          unpublished_by: string | null
          updated_at: string
          version: number
          video_duration: string | null
          video_url: string | null
        }
        Insert: {
          ai_summary?: string | null
          author_id?: string | null
          body?: string | null
          body_tsv?: unknown
          category_slug?: string | null
          cover_credit_name?: string | null
          cover_credit_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          excerpt?: string | null
          first_published_at?: string | null
          id?: string
          is_breaking?: boolean
          is_featured?: boolean
          last_edited_at?: string | null
          last_edited_by?: string | null
          last_published_at?: string | null
          origin?: string
          original_title?: string | null
          original_url?: string | null
          published_at?: string | null
          published_by?: string | null
          read_minutes?: number | null
          relevance_score?: number | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          search_norm?: string | null
          slug: string
          source_image_url?: string | null
          source_lang?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string
          title: string
          type?: string
          unpublished_at?: string | null
          unpublished_by?: string | null
          updated_at?: string
          version?: number
          video_duration?: string | null
          video_url?: string | null
        }
        Update: {
          ai_summary?: string | null
          author_id?: string | null
          body?: string | null
          body_tsv?: unknown
          category_slug?: string | null
          cover_credit_name?: string | null
          cover_credit_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          dedupe_key?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          excerpt?: string | null
          first_published_at?: string | null
          id?: string
          is_breaking?: boolean
          is_featured?: boolean
          last_edited_at?: string | null
          last_edited_by?: string | null
          last_published_at?: string | null
          origin?: string
          original_title?: string | null
          original_url?: string | null
          published_at?: string | null
          published_by?: string | null
          read_minutes?: number | null
          relevance_score?: number | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          search_norm?: string | null
          slug?: string
          source_image_url?: string | null
          source_lang?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string
          title?: string
          type?: string
          unpublished_at?: string | null
          unpublished_by?: string | null
          updated_at?: string
          version?: number
          video_duration?: string | null
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_category_slug_fkey"
            columns: ["category_slug"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "content_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_unpublished_by_fkey"
            columns: ["unpublished_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      content_audit_log: {
        Row: {
          actor_id: string | null
          actor_kind: string
          content_id: string
          created_at: string
          details: Json | null
          event: string
          from_status: string | null
          id: number
          to_status: string | null
          version_no: number | null
        }
        Insert: {
          actor_id?: string | null
          actor_kind: string
          content_id: string
          created_at?: string
          details?: Json | null
          event: string
          from_status?: string | null
          id?: never
          to_status?: string | null
          version_no?: number | null
        }
        Update: {
          actor_id?: string | null
          actor_kind?: string
          content_id?: string
          created_at?: string
          details?: Json | null
          event?: string
          from_status?: string | null
          id?: never
          to_status?: string | null
          version_no?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "content_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      content_media: {
        Row: {
          caption: string | null
          content_id: string
          created_at: string
          credit_name: string | null
          credit_url: string | null
          id: string
          sort_order: number
          storage_path: string | null
          type: string
          url: string
        }
        Insert: {
          caption?: string | null
          content_id: string
          created_at?: string
          credit_name?: string | null
          credit_url?: string | null
          id?: string
          sort_order?: number
          storage_path?: string | null
          type?: string
          url: string
        }
        Update: {
          caption?: string | null
          content_id?: string
          created_at?: string
          credit_name?: string | null
          credit_url?: string | null
          id?: string
          sort_order?: number
          storage_path?: string | null
          type?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_media_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_media_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
        ]
      }
      content_sources: {
        Row: {
          content_id: string
          created_at: string
          id: string
          label: string
          url: string | null
        }
        Insert: {
          content_id: string
          created_at?: string
          id?: string
          label: string
          url?: string | null
        }
        Update: {
          content_id?: string
          created_at?: string
          id?: string
          label?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_sources_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_sources_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
        ]
      }
      content_versions: {
        Row: {
          ai_summary: string | null
          body: string | null
          category_slug: string | null
          content_id: string
          cover_credit_name: string | null
          cover_credit_url: string | null
          cover_image_url: string | null
          created_at: string
          edited_at: string
          edited_by: string | null
          excerpt: string | null
          slug: string
          source_name: string | null
          source_url: string | null
          title: string
          type: string
          version_no: number
          video_url: string | null
        }
        Insert: {
          ai_summary?: string | null
          body?: string | null
          category_slug?: string | null
          content_id: string
          cover_credit_name?: string | null
          cover_credit_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          edited_at: string
          edited_by?: string | null
          excerpt?: string | null
          slug: string
          source_name?: string | null
          source_url?: string | null
          title: string
          type: string
          version_no: number
          video_url?: string | null
        }
        Update: {
          ai_summary?: string | null
          body?: string | null
          category_slug?: string | null
          content_id?: string
          cover_credit_name?: string | null
          cover_credit_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          edited_at?: string
          edited_by?: string | null
          excerpt?: string | null
          slug?: string
          source_name?: string | null
          source_url?: string | null
          title?: string
          type?: string
          version_no?: number
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_versions_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_versions_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
          {
            foreignKeyName: "content_versions_edited_by_fkey"
            columns: ["edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          id: string
          name_ar: string
          slug: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          id?: string
          name_ar: string
          slug: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          id?: string
          name_ar?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      doctor_ratings: {
        Row: {
          author_name: string
          body: string | null
          created_at: string
          doctor_id: string
          id: string
          stars: number
          status: string
        }
        Insert: {
          author_name: string
          body?: string | null
          created_at?: string
          doctor_id: string
          id?: string
          stars: number
          status?: string
        }
        Update: {
          author_name?: string
          body?: string | null
          created_at?: string
          doctor_id?: string
          id?: string
          stars?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_ratings_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_transfer_private: {
        Row: {
          internal_source_note: string | null
          transfer_id: string
          updated_at: string
        }
        Insert: {
          internal_source_note?: string | null
          transfer_id: string
          updated_at?: string
        }
        Update: {
          internal_source_note?: string | null
          transfer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_transfer_private_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: true
            referencedRelation: "doctor_transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_transfers: {
        Row: {
          body: string | null
          created_at: string
          deleted_at: string | null
          department_id: string | null
          doctor_name: string
          doctor_photo_url: string | null
          from_hospital: string | null
          id: string
          note: string | null
          published_at: string | null
          slug: string | null
          source_name: string | null
          source_url: string | null
          specialty: string | null
          status: string
          summary: string | null
          to_hospital: string | null
          transfer_date: string | null
          updated_at: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          doctor_name: string
          doctor_photo_url?: string | null
          from_hospital?: string | null
          id?: string
          note?: string | null
          published_at?: string | null
          slug?: string | null
          source_name?: string | null
          source_url?: string | null
          specialty?: string | null
          status?: string
          summary?: string | null
          to_hospital?: string | null
          transfer_date?: string | null
          updated_at?: string
        }
        Update: {
          body?: string | null
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          doctor_name?: string
          doctor_photo_url?: string | null
          from_hospital?: string | null
          id?: string
          note?: string | null
          published_at?: string | null
          slug?: string | null
          source_name?: string | null
          source_url?: string | null
          specialty?: string | null
          status?: string
          summary?: string | null
          to_hospital?: string | null
          transfer_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_transfers_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      doctors: {
        Row: {
          bio: string | null
          created_at: string
          deleted_at: string | null
          department_id: string | null
          hospital: string | null
          id: string
          name_ar: string
          photo_url: string | null
          rating_avg: number
          rating_count: number
          slug: string
          title_ar: string | null
          updated_at: string
        }
        Insert: {
          bio?: string | null
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          hospital?: string | null
          id?: string
          name_ar: string
          photo_url?: string | null
          rating_avg?: number
          rating_count?: number
          slug: string
          title_ar?: string | null
          updated_at?: string
        }
        Update: {
          bio?: string | null
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          hospital?: string | null
          id?: string
          name_ar?: string
          photo_url?: string | null
          rating_avg?: number
          rating_count?: number
          slug?: string
          title_ar?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctors_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      editorial_ai_baseline: {
        Row: {
          body: string | null
          captured_at: string
          category_slug: string | null
          content_id: string
          cover_image_url: string | null
          source_name: string | null
          source_url: string | null
          title: string
        }
        Insert: {
          body?: string | null
          captured_at?: string
          category_slug?: string | null
          content_id: string
          cover_image_url?: string | null
          source_name?: string | null
          source_url?: string | null
          title: string
        }
        Update: {
          body?: string | null
          captured_at?: string
          category_slug?: string | null
          content_id?: string
          cover_image_url?: string | null
          source_name?: string | null
          source_url?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "editorial_ai_baseline_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: true
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "editorial_ai_baseline_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: true
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
        ]
      }
      editorial_feedback_events: {
        Row: {
          action: string
          actor_id: string | null
          after_value: string | null
          before_value: string | null
          content_id: string
          created_at: string
          edit_magnitude: string | null
          edit_ratio: number | null
          id: number
          meta: Json | null
          origin: string | null
          reason: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          after_value?: string | null
          before_value?: string | null
          content_id: string
          created_at?: string
          edit_magnitude?: string | null
          edit_ratio?: number | null
          id?: never
          meta?: Json | null
          origin?: string | null
          reason?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          after_value?: string | null
          before_value?: string | null
          content_id?: string
          created_at?: string
          edit_magnitude?: string | null
          edit_ratio?: number | null
          id?: never
          meta?: Json | null
          origin?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "editorial_feedback_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "editorial_feedback_events_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "editorial_feedback_events_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
        ]
      }
      editorial_policy: {
        Row: {
          block_topics: string[]
          id: string
          priority_topics: string[]
          regions: string[]
          trusted_sources: string[]
          updated_at: string
        }
        Insert: {
          block_topics?: string[]
          id?: string
          priority_topics?: string[]
          regions?: string[]
          trusted_sources?: string[]
          updated_at?: string
        }
        Update: {
          block_topics?: string[]
          id?: string
          priority_topics?: string[]
          regions?: string[]
          trusted_sources?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      homepage_sections: {
        Row: {
          accent: string | null
          category_slug: string | null
          created_at: string
          display_style: string
          id: string
          is_enabled: boolean
          items_limit: number
          key: string
          kind: string
          show_view_all: boolean
          sort_order: number
          title_ar: string
          updated_at: string
        }
        Insert: {
          accent?: string | null
          category_slug?: string | null
          created_at?: string
          display_style?: string
          id?: string
          is_enabled?: boolean
          items_limit?: number
          key: string
          kind: string
          show_view_all?: boolean
          sort_order?: number
          title_ar: string
          updated_at?: string
        }
        Update: {
          accent?: string | null
          category_slug?: string | null
          created_at?: string
          display_style?: string
          id?: string
          is_enabled?: boolean
          items_limit?: number
          key?: string
          kind?: string
          show_view_all?: boolean
          sort_order?: number
          title_ar?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "homepage_sections_category_slug_fkey"
            columns: ["category_slug"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["slug"]
          },
        ]
      }
      ingestion_decisions: {
        Row: {
          accepted: boolean
          created_at: string
          dedupe_method: string | null
          duplicate_of_content_id: string | null
          editorial_value_score: number | null
          id: string
          institutional_pr_score: number | null
          matched_title: string | null
          model: string | null
          prompt_version: string | null
          rejection_reason: string | null
          run_id: string | null
          selected_final_domain: string | null
          similarity_score: number | null
          source_char_count: number | null
          source_domain: string | null
          source_extraction_method: string | null
          source_tier: string | null
          source_trust_score: number | null
          source_url: string | null
          source_word_count: number | null
          title: string | null
          writer_fallback_used: boolean | null
          writer_model_used: string | null
          writer_primary_model: string | null
          writer_prompt_version: string | null
          writer_validation_reason: string | null
          writing_profile: string | null
        }
        Insert: {
          accepted?: boolean
          created_at?: string
          dedupe_method?: string | null
          duplicate_of_content_id?: string | null
          editorial_value_score?: number | null
          id?: string
          institutional_pr_score?: number | null
          matched_title?: string | null
          model?: string | null
          prompt_version?: string | null
          rejection_reason?: string | null
          run_id?: string | null
          selected_final_domain?: string | null
          similarity_score?: number | null
          source_char_count?: number | null
          source_domain?: string | null
          source_extraction_method?: string | null
          source_tier?: string | null
          source_trust_score?: number | null
          source_url?: string | null
          source_word_count?: number | null
          title?: string | null
          writer_fallback_used?: boolean | null
          writer_model_used?: string | null
          writer_primary_model?: string | null
          writer_prompt_version?: string | null
          writer_validation_reason?: string | null
          writing_profile?: string | null
        }
        Update: {
          accepted?: boolean
          created_at?: string
          dedupe_method?: string | null
          duplicate_of_content_id?: string | null
          editorial_value_score?: number | null
          id?: string
          institutional_pr_score?: number | null
          matched_title?: string | null
          model?: string | null
          prompt_version?: string | null
          rejection_reason?: string | null
          run_id?: string | null
          selected_final_domain?: string | null
          similarity_score?: number | null
          source_char_count?: number | null
          source_domain?: string | null
          source_extraction_method?: string | null
          source_tier?: string | null
          source_trust_score?: number | null
          source_url?: string | null
          source_word_count?: number | null
          title?: string | null
          writer_fallback_used?: boolean | null
          writer_model_used?: string | null
          writer_primary_model?: string | null
          writer_prompt_version?: string | null
          writer_validation_reason?: string | null
          writing_profile?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_decisions_duplicate_of_content_id_fkey"
            columns: ["duplicate_of_content_id"]
            isOneToOne: false
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingestion_decisions_duplicate_of_content_id_fkey"
            columns: ["duplicate_of_content_id"]
            isOneToOne: false
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
          {
            foreignKeyName: "ingestion_decisions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "ingestion_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      ingestion_runs: {
        Row: {
          created_at: string
          created_ids: string[]
          duplicates: number
          duration_ms: number | null
          error: string | null
          filtered: number
          found: number
          id: string
          kept: number
          pilot_source_domain: string | null
          sources: string[]
          status: string
          trigger: string
        }
        Insert: {
          created_at?: string
          created_ids?: string[]
          duplicates?: number
          duration_ms?: number | null
          error?: string | null
          filtered?: number
          found?: number
          id?: string
          kept?: number
          pilot_source_domain?: string | null
          sources?: string[]
          status?: string
          trigger?: string
        }
        Update: {
          created_at?: string
          created_ids?: string[]
          duplicates?: number
          duration_ms?: number | null
          error?: string | null
          filtered?: number
          found?: number
          id?: string
          kept?: number
          pilot_source_domain?: string | null
          sources?: string[]
          status?: string
          trigger?: string
        }
        Relationships: []
      }
      news_sources: {
        Row: {
          active: boolean
          created_at: string
          discovery_enabled: boolean
          domain: string
          feed_url: string | null
          final_source_allowed: boolean
          id: string
          name: string
          notes: string | null
          region: string
          source_type: string
          tier: string
          trust_score: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          discovery_enabled?: boolean
          domain: string
          feed_url?: string | null
          final_source_allowed?: boolean
          id?: string
          name: string
          notes?: string | null
          region: string
          source_type: string
          tier?: string
          trust_score?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          discovery_enabled?: boolean
          domain?: string
          feed_url?: string | null
          final_source_allowed?: boolean
          id?: string
          name?: string
          notes?: string | null
          region?: string
          source_type?: string
          tier?: string
          trust_score?: number
          updated_at?: string
        }
        Relationships: []
      }
      newsletter_subscribers: {
        Row: {
          created_at: string
          email: string
          id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          created_by: string | null
          disabled: boolean
          email: string | null
          full_name: string | null
          id: string
          last_login_at: string | null
          notification_prefs: Json
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          disabled?: boolean
          email?: string | null
          full_name?: string | null
          id: string
          last_login_at?: string | null
          notification_prefs?: Json
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          disabled?: boolean
          email?: string | null
          full_name?: string | null
          id?: string
          last_login_at?: string | null
          notification_prefs?: Json
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      radar_cleanup_runs: {
        Row: {
          batches: number | null
          deleted: number | null
          details: Json | null
          duration_ms: number | null
          error: string | null
          examined: number | null
          finished_at: string | null
          id: number
          started_at: string
          status: string
        }
        Insert: {
          batches?: number | null
          deleted?: number | null
          details?: Json | null
          duration_ms?: number | null
          error?: string | null
          examined?: number | null
          finished_at?: string | null
          id?: never
          started_at?: string
          status?: string
        }
        Update: {
          batches?: number | null
          deleted?: number | null
          details?: Json | null
          duration_ms?: number | null
          error?: string | null
          examined?: number | null
          finished_at?: string | null
          id?: never
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      radar_editorial_selection: {
        Row: {
          chosen_source_domain: string | null
          chosen_source_title: string | null
          cluster_key: string
          composite_score: number | null
          created_at: string
          editorial_day: string
          esc_editorial_domain: string | null
          esc_editorial_tier: number | null
          esc_method: string | null
          esc_status: string | null
          evidence_class: string | null
          gcc: boolean | null
          id: number
          lane: string | null
          lane_confidence: number | null
          mode: string
          promoted_content_id: string | null
          promotion_status: string | null
          radar_article_id: string
          run_id: string
          selected: boolean
          selection_reason: string | null
          skip_reason: string | null
          source_role: string | null
          source_tier: number | null
          story_type: string | null
        }
        Insert: {
          chosen_source_domain?: string | null
          chosen_source_title?: string | null
          cluster_key: string
          composite_score?: number | null
          created_at?: string
          editorial_day: string
          esc_editorial_domain?: string | null
          esc_editorial_tier?: number | null
          esc_method?: string | null
          esc_status?: string | null
          evidence_class?: string | null
          gcc?: boolean | null
          id?: never
          lane?: string | null
          lane_confidence?: number | null
          mode?: string
          promoted_content_id?: string | null
          promotion_status?: string | null
          radar_article_id: string
          run_id: string
          selected?: boolean
          selection_reason?: string | null
          skip_reason?: string | null
          source_role?: string | null
          source_tier?: number | null
          story_type?: string | null
        }
        Update: {
          chosen_source_domain?: string | null
          chosen_source_title?: string | null
          cluster_key?: string
          composite_score?: number | null
          created_at?: string
          editorial_day?: string
          esc_editorial_domain?: string | null
          esc_editorial_tier?: number | null
          esc_method?: string | null
          esc_status?: string | null
          evidence_class?: string | null
          gcc?: boolean | null
          id?: never
          lane?: string | null
          lane_confidence?: number | null
          mode?: string
          promoted_content_id?: string | null
          promotion_status?: string | null
          radar_article_id?: string
          run_id?: string
          selected?: boolean
          selection_reason?: string | null
          skip_reason?: string | null
          source_role?: string | null
          source_tier?: number | null
          story_type?: string | null
        }
        Relationships: []
      }
      radar_esl_runs: {
        Row: {
          cap: number | null
          clusters: number | null
          duration_ms: number | null
          editorial_day: string | null
          error: string | null
          finished_at: string | null
          id: string
          job: string
          mode: string | null
          pool_size: number | null
          promoted: number | null
          promotion_failed: number | null
          remaining_cap: number | null
          selected: number | null
          started_at: string
          status: string
        }
        Insert: {
          cap?: number | null
          clusters?: number | null
          duration_ms?: number | null
          editorial_day?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          job?: string
          mode?: string | null
          pool_size?: number | null
          promoted?: number | null
          promotion_failed?: number | null
          remaining_cap?: number | null
          selected?: number | null
          started_at?: string
          status: string
        }
        Update: {
          cap?: number | null
          clusters?: number | null
          duration_ms?: number | null
          editorial_day?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          job?: string
          mode?: string | null
          pool_size?: number | null
          promoted?: number | null
          promotion_failed?: number | null
          remaining_cap?: number | null
          selected?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      radar_evidence_intelligence: {
        Row: {
          analysis_status: string
          analyzed_domain: string | null
          analyzed_url: string | null
          applicability: string | null
          card: Json | null
          claim_relationship: string | null
          cluster_key: string
          content_id: string | null
          created_at: string
          editorial_primary_domain: string | null
          editorial_primary_url: string | null
          evidence_source_role: string | null
          evidence_source_status: string | null
          evidence_source_tier: number | null
          evidence_strength: string | null
          evidence_type: string | null
          id: string
          model: string | null
          peer_review_status: string | null
          prompt_version: string | null
          reason: string | null
          sample_size: number | null
          source_independence: string | null
          story_type: string | null
          subject_type: string | null
          updated_at: string
        }
        Insert: {
          analysis_status: string
          analyzed_domain?: string | null
          analyzed_url?: string | null
          applicability?: string | null
          card?: Json | null
          claim_relationship?: string | null
          cluster_key: string
          content_id?: string | null
          created_at?: string
          editorial_primary_domain?: string | null
          editorial_primary_url?: string | null
          evidence_source_role?: string | null
          evidence_source_status?: string | null
          evidence_source_tier?: number | null
          evidence_strength?: string | null
          evidence_type?: string | null
          id?: string
          model?: string | null
          peer_review_status?: string | null
          prompt_version?: string | null
          reason?: string | null
          sample_size?: number | null
          source_independence?: string | null
          story_type?: string | null
          subject_type?: string | null
          updated_at?: string
        }
        Update: {
          analysis_status?: string
          analyzed_domain?: string | null
          analyzed_url?: string | null
          applicability?: string | null
          card?: Json | null
          claim_relationship?: string | null
          cluster_key?: string
          content_id?: string | null
          created_at?: string
          editorial_primary_domain?: string | null
          editorial_primary_url?: string | null
          evidence_source_role?: string | null
          evidence_source_status?: string | null
          evidence_source_tier?: number | null
          evidence_strength?: string | null
          evidence_type?: string | null
          id?: string
          model?: string | null
          peer_review_status?: string | null
          prompt_version?: string | null
          reason?: string | null
          sample_size?: number | null
          source_independence?: string | null
          story_type?: string | null
          subject_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "radar_evidence_intelligence_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "content"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radar_evidence_intelligence_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "editorial_feedback_overview"
            referencedColumns: ["content_id"]
          },
        ]
      }
      radar_rank_runs: {
        Row: {
          attempted_count: number
          backlog_after: number | null
          backlog_before: number | null
          completion_tokens: number
          cost: number | null
          duplicate_already_count: number
          duplicate_new_count: number
          duplicate_possible_count: number
          duration_ms: number | null
          error: string | null
          finished_at: string | null
          id: string
          model: string | null
          openrouter_calls: number
          prompt_tokens: number
          ranked_count: number
          retry_count: number
          skipped_count: number | null
          started_at: string
          status: string
          total_tokens: number
          trigger: string
          unranked_error_count: number
        }
        Insert: {
          attempted_count?: number
          backlog_after?: number | null
          backlog_before?: number | null
          completion_tokens?: number
          cost?: number | null
          duplicate_already_count?: number
          duplicate_new_count?: number
          duplicate_possible_count?: number
          duration_ms?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          model?: string | null
          openrouter_calls?: number
          prompt_tokens?: number
          ranked_count?: number
          retry_count?: number
          skipped_count?: number | null
          started_at?: string
          status?: string
          total_tokens?: number
          trigger?: string
          unranked_error_count?: number
        }
        Update: {
          attempted_count?: number
          backlog_after?: number | null
          backlog_before?: number | null
          completion_tokens?: number
          cost?: number | null
          duplicate_already_count?: number
          duplicate_new_count?: number
          duplicate_possible_count?: number
          duration_ms?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          model?: string | null
          openrouter_calls?: number
          prompt_tokens?: number
          ranked_count?: number
          retry_count?: number
          skipped_count?: number | null
          started_at?: string
          status?: string
          total_tokens?: number
          trigger?: string
          unranked_error_count?: number
        }
        Relationships: []
      }
      radar_shadow_articles: {
        Row: {
          country: string | null
          duplicate_status: string | null
          editorial_value: string | null
          esl_canonical_key: string | null
          esl_canonicalized_at: string | null
          esl_classified_at: string | null
          esl_evidence_class: string | null
          esl_gcc: boolean | null
          esl_lane: string | null
          esl_story_type: string | null
          esl_usefulness: number | null
          event_uri: string | null
          expected_category_slug: string | null
          first_seen_at: string
          id: string
          language: string | null
          matched_content_id: string | null
          priority_level: string | null
          priority_score: number | null
          provider: string
          provider_seen_at: string | null
          provider_uri: string
          publish_authorized_at: string | null
          publish_authorized_by: string | null
          publish_error: string | null
          publish_status: string | null
          published_at: string | null
          published_content_id: string | null
          rank_attempts: number
          rank_error: string | null
          ranked_at: string | null
          run_id: string | null
          source_domain: string | null
          source_title: string | null
          title: string | null
          title_ar: string | null
          url: string | null
        }
        Insert: {
          country?: string | null
          duplicate_status?: string | null
          editorial_value?: string | null
          esl_canonical_key?: string | null
          esl_canonicalized_at?: string | null
          esl_classified_at?: string | null
          esl_evidence_class?: string | null
          esl_gcc?: boolean | null
          esl_lane?: string | null
          esl_story_type?: string | null
          esl_usefulness?: number | null
          event_uri?: string | null
          expected_category_slug?: string | null
          first_seen_at?: string
          id?: string
          language?: string | null
          matched_content_id?: string | null
          priority_level?: string | null
          priority_score?: number | null
          provider?: string
          provider_seen_at?: string | null
          provider_uri: string
          publish_authorized_at?: string | null
          publish_authorized_by?: string | null
          publish_error?: string | null
          publish_status?: string | null
          published_at?: string | null
          published_content_id?: string | null
          rank_attempts?: number
          rank_error?: string | null
          ranked_at?: string | null
          run_id?: string | null
          source_domain?: string | null
          source_title?: string | null
          title?: string | null
          title_ar?: string | null
          url?: string | null
        }
        Update: {
          country?: string | null
          duplicate_status?: string | null
          editorial_value?: string | null
          esl_canonical_key?: string | null
          esl_canonicalized_at?: string | null
          esl_classified_at?: string | null
          esl_evidence_class?: string | null
          esl_gcc?: boolean | null
          esl_lane?: string | null
          esl_story_type?: string | null
          esl_usefulness?: number | null
          event_uri?: string | null
          expected_category_slug?: string | null
          first_seen_at?: string
          id?: string
          language?: string | null
          matched_content_id?: string | null
          priority_level?: string | null
          priority_score?: number | null
          provider?: string
          provider_seen_at?: string | null
          provider_uri?: string
          publish_authorized_at?: string | null
          publish_authorized_by?: string | null
          publish_error?: string | null
          publish_status?: string | null
          published_at?: string | null
          published_content_id?: string | null
          rank_attempts?: number
          rank_error?: string | null
          ranked_at?: string | null
          run_id?: string | null
          source_domain?: string | null
          source_title?: string | null
          title?: string | null
          title_ar?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "radar_shadow_articles_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "radar_shadow_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      radar_shadow_runs: {
        Row: {
          checkpoint_after: string | null
          checkpoint_before: string | null
          duplicate_count: number
          error: string | null
          finished_at: string | null
          hit_result_cap: boolean | null
          id: string
          inserted_count: number
          languages: string[]
          profile: string | null
          returned_count: number
          stale_skipped_count: number
          started_at: string
          status: string
          trigger: string
          usage_info: Json | null
        }
        Insert: {
          checkpoint_after?: string | null
          checkpoint_before?: string | null
          duplicate_count?: number
          error?: string | null
          finished_at?: string | null
          hit_result_cap?: boolean | null
          id?: string
          inserted_count?: number
          languages?: string[]
          profile?: string | null
          returned_count?: number
          stale_skipped_count?: number
          started_at?: string
          status?: string
          trigger?: string
          usage_info?: Json | null
        }
        Update: {
          checkpoint_after?: string | null
          checkpoint_before?: string | null
          duplicate_count?: number
          error?: string | null
          finished_at?: string | null
          hit_result_cap?: boolean | null
          id?: string
          inserted_count?: number
          languages?: string[]
          profile?: string | null
          returned_count?: number
          stale_skipped_count?: number
          started_at?: string
          status?: string
          trigger?: string
          usage_info?: Json | null
        }
        Relationships: []
      }
      radar_shadow_state: {
        Row: {
          last_poll_tm: string | null
          provider: string
          updated_at: string
        }
        Insert: {
          last_poll_tm?: string | null
          provider?: string
          updated_at?: string
        }
        Update: {
          last_poll_tm?: string | null
          provider?: string
          updated_at?: string
        }
        Relationships: []
      }
      radar_source_escalation: {
        Row: {
          cluster_key: string
          created_at: string
          discovery_domain: string | null
          discovery_role: string | null
          discovery_tier: number | null
          discovery_url: string | null
          editorial_domain: string | null
          editorial_role: string | null
          editorial_tier: number | null
          editorial_url: string | null
          id: number
          method: string | null
          status: string
          story_type: string | null
          supporting_url: string | null
          updated_at: string
          upgrade_reason: string | null
        }
        Insert: {
          cluster_key: string
          created_at?: string
          discovery_domain?: string | null
          discovery_role?: string | null
          discovery_tier?: number | null
          discovery_url?: string | null
          editorial_domain?: string | null
          editorial_role?: string | null
          editorial_tier?: number | null
          editorial_url?: string | null
          id?: never
          method?: string | null
          status: string
          story_type?: string | null
          supporting_url?: string | null
          updated_at?: string
          upgrade_reason?: string | null
        }
        Update: {
          cluster_key?: string
          created_at?: string
          discovery_domain?: string | null
          discovery_role?: string | null
          discovery_tier?: number | null
          discovery_url?: string | null
          editorial_domain?: string | null
          editorial_role?: string | null
          editorial_tier?: number | null
          editorial_url?: string | null
          id?: never
          method?: string | null
          status?: string
          story_type?: string | null
          supporting_url?: string | null
          updated_at?: string
          upgrade_reason?: string | null
        }
        Relationships: []
      }
      social_answers: {
        Row: {
          answer: string
          approved_at: string | null
          approved_by: string | null
          created_at: string
          id: string
          is_featured: boolean
          name_optional: string | null
          question_id: string
          status: string
        }
        Insert: {
          answer: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          is_featured?: boolean
          name_optional?: string | null
          question_id: string
          status?: string
        }
        Update: {
          answer?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          is_featured?: boolean
          name_optional?: string | null
          question_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_answers_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "social_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      social_questions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          question: string
          require_approval: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          question: string
          require_approval?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          question?: string
          require_approval?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_questions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      editorial_feedback_overview: {
        Row: {
          ai_title: string | null
          body_edit_magnitude: string | null
          body_edit_ratio: number | null
          category_after: string | null
          category_before: string | null
          category_corrected: boolean | null
          category_slug: string | null
          chosen_source_domain: string | null
          cluster_key: string | null
          composite_score: number | null
          content_id: string | null
          created_at: string | null
          ei_claim_relationship: string | null
          ei_evidence_type: string | null
          ei_peer_review: string | null
          ei_source_independence: string | null
          ei_status: string | null
          ei_strength: string | null
          ei_subject_type: string | null
          esc_discovery_tier: number | null
          esc_editorial_tier: number | null
          esc_method: string | null
          esc_status: string | null
          esl_selected: boolean | null
          evidence_class: string | null
          final_title: string | null
          gcc: boolean | null
          image_changed: boolean | null
          lane: string | null
          published_at: string | null
          reject_reason: string | null
          selection_reason: string | null
          source_after: string | null
          source_before: string | null
          source_changed: boolean | null
          source_role: string | null
          source_tier: number | null
          status: string | null
          story_type: string | null
          title: string | null
          title_edit_magnitude: string | null
          title_edit_ratio: number | null
          usefulness: number | null
          was_edited: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "content_category_slug_fkey"
            columns: ["category_slug"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["slug"]
          },
        ]
      }
      pipeline_health: {
        Row: {
          backlog: number | null
          expected_cadence: string | null
          failures_24h: number | null
          last_ok_at: string | null
          last_run_at: string | null
          last_status: string | null
          ok_tolerance: string | null
          stage: string | null
          stale_running: number | null
        }
        Relationships: []
      }
      pipeline_health_alerts: {
        Row: {
          alert: string | null
          detail: string | null
          stage: string | null
        }
        Relationships: []
      }
      radar_rank_health: {
        Row: {
          backlog_unranked: number | null
          backlog_unranked_24h: number | null
          last_run_started_at: string | null
          last_run_status: string | null
          last_success_at: string | null
          stale_running_runs: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      ar_normalize: { Args: { p_input: string }; Returns: string }
      complete_ai_image: {
        Args: {
          p_actual: number
          p_failure_reason: string
          p_reservation_id: number
          p_status: string
          p_user_id: string
        }
        Returns: undefined
      }
      content_counts: {
        Args: never
        Returns: {
          category_slug: string
          n: number
          scope: string
          status: string
        }[]
      }
      create_transfer_with_private: {
        Args: {
          p_doctor_name: string
          p_doctor_photo_url?: string
          p_from_hospital?: string
          p_internal_source?: string
          p_specialty?: string
          p_status?: string
          p_to_hospital?: string
        }
        Returns: string
      }
      is_admin: { Args: never; Returns: boolean }
      is_admin_manager: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      log_admin_denied: {
        Args: { p_action: string; p_detail: string; p_target: string }
        Returns: undefined
      }
      normalize_host: { Args: { input: string }; Returns: string }
      radar_cleanup: {
        Args: { p_batch_limit?: number; p_max_batches?: number }
        Returns: Json
      }
      reserve_ai_image: {
        Args: {
          p_max_images_global_24h: number
          p_max_images_user_24h: number
          p_max_premium_global_24h: number
          p_max_req_per_min: number
          p_quality: string
          p_requested: number
          p_stale_seconds: number
          p_user_id: string
        }
        Returns: {
          allowed: boolean
          reason: string
          reservation_id: number
        }[]
      }
      restore_content_version: {
        Args: { p_content_id: string; p_version_no: number }
        Returns: Json
      }
      run_esl: { Args: { p_mode?: string }; Returns: undefined }
      run_news_ingestion: { Args: never; Returns: undefined }
      run_radar_healthlife: { Args: never; Returns: undefined }
      run_radar_rank: { Args: never; Returns: undefined }
      run_radar_shadow: { Args: never; Returns: undefined }
      search_content: {
        Args: {
          p_author?: string
          p_author_system?: boolean
          p_category?: string
          p_cursor_id?: string
          p_cursor_ts?: string
          p_from?: string
          p_limit?: number
          p_publisher?: string
          p_q?: string
          p_reviewer?: string
          p_sort?: string
          p_status?: string
          p_to?: string
        }
        Returns: {
          author_name: string
          category_name_ar: string
          category_slug: string
          deleted_at: string
          deleted_by_name: string
          id: string
          last_edited_at: string
          published_at: string
          slug: string
          status: string
          title: string
          type: string
          version: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
