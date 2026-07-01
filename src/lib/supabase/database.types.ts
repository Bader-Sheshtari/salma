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
          slug: string
          sort_order: number
        }
        Insert: {
          accent?: string
          name_ar: string
          name_en?: string | null
          slug: string
          sort_order?: number
        }
        Update: {
          accent?: string
          name_ar?: string
          name_en?: string | null
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
        ]
      }
      content: {
        Row: {
          ai_summary: string | null
          author_id: string | null
          body: string | null
          category_slug: string | null
          cover_credit_name: string | null
          cover_credit_url: string | null
          cover_image_url: string | null
          created_at: string
          dedupe_key: string | null
          deleted_at: string | null
          excerpt: string | null
          id: string
          is_breaking: boolean
          is_featured: boolean
          origin: string
          original_title: string | null
          original_url: string | null
          published_at: string | null
          read_minutes: number | null
          relevance_score: number | null
          slug: string
          source_lang: string | null
          source_name: string | null
          source_url: string | null
          status: string
          title: string
          type: string
          updated_at: string
          video_duration: string | null
          video_url: string | null
        }
        Insert: {
          ai_summary?: string | null
          author_id?: string | null
          body?: string | null
          category_slug?: string | null
          cover_credit_name?: string | null
          cover_credit_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          dedupe_key?: string | null
          deleted_at?: string | null
          excerpt?: string | null
          id?: string
          is_breaking?: boolean
          is_featured?: boolean
          origin?: string
          original_title?: string | null
          original_url?: string | null
          published_at?: string | null
          read_minutes?: number | null
          relevance_score?: number | null
          slug: string
          source_lang?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string
          title: string
          type?: string
          updated_at?: string
          video_duration?: string | null
          video_url?: string | null
        }
        Update: {
          ai_summary?: string | null
          author_id?: string | null
          body?: string | null
          category_slug?: string | null
          cover_credit_name?: string | null
          cover_credit_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          dedupe_key?: string | null
          deleted_at?: string | null
          excerpt?: string | null
          id?: string
          is_breaking?: boolean
          is_featured?: boolean
          origin?: string
          original_title?: string | null
          original_url?: string | null
          published_at?: string | null
          read_minutes?: number | null
          relevance_score?: number | null
          slug?: string
          source_lang?: string | null
          source_name?: string | null
          source_url?: string | null
          status?: string
          title?: string
          type?: string
          updated_at?: string
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
          sources?: string[]
          status?: string
          trigger?: string
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
      [_ in never]: never
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
      run_news_ingestion: { Args: never; Returns: undefined }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
