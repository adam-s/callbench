<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<div class="wrap">
	{@render children()}
</div>
